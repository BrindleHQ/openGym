# Running openGym for Brindle

This is how BrindleHQ/openGym is built, deployed, backed up and released. Upstream's guides
([SELF_HOSTING.md](SELF_HOSTING.md) and the rest) still describe the app itself. This file covers
only our deployment.

## Environments

| | Development | Staging | Production |
|---|---|---|---|
| Where | Devbox | Boop Beep, Coolify project **openGym**, environment `staging` | Boop Beep, Coolify project **openGym**, environment `production` |
| Exposure | your machine | tailnet only | tailnet only |
| Address | `http://localhost:8080` (compose) or `:5173` (Vite) | <https://boop-beep.tail5728d8.ts.net:9443> | <https://boop-beep.tail5728d8.ts.net:8443> |
| Public address, if switched | none | `https://opengym-staging.brindle.to` | `https://opengym.brindle.to` |
| Data | `./data` in your checkout | `/srv/opengym/staging/data` | `/srv/opengym/production/data` |
| Backups | none | `/srv/opengym/staging/backups`, nightly 03:17 UTC, 7 days | `/srv/opengym/production/backups`, nightly 02:47 UTC, 30 days |
| Deployed by | you, by hand | every green push to `main`, automatically | right after staging, automatically |
| Coolify service | none | `opengym-staging` | `opengym-production` |

No two environments share data, address, Coolify service, GitHub environment or deploy key.
openGym keeps its own secrets in its data directory: the session key (`secret`) and the push keys
(`vapid.json`). So each environment's secrets live only in that environment's directory.

Nothing that runs in production runs on Devbox, and Devbox holds no production data.

## Tailnet or public: one setting

Each environment's `exposure` in `deploy/environments.json` decides who can reach it:

- `"tailnet"` (both, today): only devices on our Tailscale network. The web container listens
  on a loopback port of Boop Beep, and `tailscale serve` puts HTTPS in front of it at
  `https://<tailnet.host>:<tailnet.port>`. Nothing routes it from the internet. The iPhone app
  syncs while Tailscale is on, and keeps logging offline otherwise.
- `"public"`: anyone on the internet, at `https://<public.host>` on `brindle.to`, through the
  Cloudflare tunnel and a Coolify domain. Invite-only and passkeys still apply.

To switch, change that one word in a pull request. The deploy script, the deploy jobs (which join
the tailnet only for a tailnet environment), the environment link in GitHub and `uptime.yml` all
follow it. The tailnet address keeps answering in public mode, for checks, but sign-in belongs to
one address only.

**Switch before the environment has accounts.** A passkey works only on the hostname it was made
for, so switching later locks every profile out. If you must switch afterwards, give each person a
recovery code from inside the API container (`node recover.js "<name>"`, see SELF_HOSTING.md),
which lets them add a passkey for the new address. Before going public, also turn on **Always Use
HTTPS** and **HSTS** for `brindle.to` in Cloudflare, so a plain `http://` visit is upgraded.

## Daily development

```bash
git switch -c my-change origin/main
cd frontend && npm install && npm run dev      # app on :5173; /api goes to :3000
cd api && npm install && node server.js        # API on :3000, data in api/data
# or both containers, as staging runs them:
cp .env.example .env && docker compose up -d --build   # http://localhost:8080
```

Run the suites before you push. Use Node 22, the version CI and the images use:

```bash
cd frontend && npm test
cd api && npm test
node --test "scripts/deploy/*.test.mjs"
```

Push the branch and open a pull request against `BrindleHQ/openGym` `main` (never upstream).
The `Tests` workflow runs. Its last job, **tests-ok**, is the check the `main` ruleset requires.
It passes when every job that had something to check passed:

- the frontend, API, MCP and catalogue suites;
- the image build and boot (`images`);
- the deploy tooling (`deploy-config`);
- the runtime dependency audit (`deps-audit`).

Merge when it is green. Nothing else is needed: staging, then production, follow.

## Releases, deploys and rollback

The model is the one T3 Code, Cloudflare Workers, Vercel and Kamal use: every release is an
immutable build, `main` is what runs, earlier releases stay on hand, and a rollback is a switch
back to one of them, run directly against the host, not through CI.

```
pull request ──> Tests (tests-ok)
merge to main ─> Tests ─> publish ─────────────> deploy-staging ──> deploy-production
                          build once, push to     same release        same release, if staging
                          GHCR, smoke-test by                         took it
                          digest
rollback ────────> ssh boop-beep sudo opengym-release rollback production     (about 4 s)
```

- **A release** is one green commit on `main`: `publish` builds `ghcr.io/brindlehq/opengym-api`
  and `opengym-web` once, pulls them back by digest, runs `scripts/deploy/smoke.sh`, and saves
  `release.json` (the commit and both digests) as the run's `release` artifact for 90 days.
  Nothing is rebuilt after that.
- **A deploy** (`.github/workflows/deploy.yml`, for staging and then production) renders a plan
  from the release's own commit (`scripts/deploy/coolify.mjs plan`: the compose for the
  environment, its settings and what it must show when live), joins the tailnet, and sends the
  plan over SSH to **`opengym-release`** on Boop Beep with the environment's own key. That key can
  run `opengym-release` for its environment and nothing else. The job then checks the address
  from outside (`coolify.mjs verify`).
- **`opengym-release`** (`deploy/opengym-release.sh`, installed by `host-setup.sh`) does the
  deploy on the host:
  - one operation per environment at a time (a lock: a second deploy waits);
  - it uploads the compose to the environment's Coolify service, has Coolify start it, and waits
    for Coolify's own record of that run. Coolify does not queue compose deploys or report their
    end over its API, and two overlapping runs once took staging down for five minutes;
  - the new release must then be healthy and serve its commit (`release.json`) with the planned
    `invite_only` and `allow_guest`. If not, it **restores the release that was live** and fails;
  - it keeps what Coolify generated as the release's snapshot: the last 10 per environment, in
    `/srv/opengym/<env>/releases/`.
- **A rollback** starts a kept snapshot directly with docker compose. Nothing is built, pulled
  or queued, and Coolify is told afterwards. Measured on staging: **3.9 s** on the host, 4.2 s
  from Devbox, with the site unavailable for 3.5 s.

openGym's API keeps its data in memory and in files, so two copies may never run at once. That
is why there is no Kamal-style overlap: the old containers stop, then the new ones start. A
deploy or rollback is unavailable for about 3 to 4 seconds, and the apps keep their changes and
sync when it is back.

### Commands (for you or an agent)

Every line `opengym-release` prints is one JSON object, and the last has `"ok": true` or `false`.

```bash
ssh boop-beep sudo opengym-release status production       # what is live, and what it serves
ssh boop-beep sudo opengym-release history production      # the kept releases, newest first
ssh boop-beep sudo opengym-release rollback production     # back to the release before the live one
ssh boop-beep sudo opengym-release rollback production 20261031T195648Z-28a6f29   # or a named one
# deploy a release by hand (CI does this): a plan on stdin
node scripts/deploy/coolify.mjs plan production release.json | ssh boop-beep sudo opengym-release deploy production
```

A rollback needs no approval: it only goes back to a release production has already run. The
next merge to `main` deploys forward again. To keep a rollback, revert the change on `main`.

For a release older than the ten kept on the host, run **Deploy an earlier release**
(`promote.yml`) with the `run_id` of its Tests run (artifacts last 90 days). Older still, the
images are in GHCR as `sha-<commit>`: write a `release.json` with the digests from
`docker buildx imagetools inspect ghcr.io/brindlehq/opengym-api:sha-<commit>` and deploy it by
hand as above.

**A rollback does not roll back data.** openGym has no schema migrations: the profile is one JSON
document per user, and older code ignores fields it does not know. So a server image can go back
safely. Two things do not go back:

- Data written by a newer app version stays as it was written.
- The iPhone app has its UI built in. Deploying the server never changes the app on a phone.

If a release damaged data, restore a backup instead (below). That also discards every change
made since the backup, on every device that has not synced yet. Prefer the rollback, and
restore only when the data itself is wrong.

## Backups and restore

The `backup` container in each environment (offen/docker-volume-backup, pinned by digest) writes
`opengym-<env>-<UTC timestamp>.tar.gz` into the backups directory every night. It deletes
archives older than the retention period. The archive holds the whole data directory: profiles,
passkeys, workouts, uploads and the session key. So the backups directory is root-only (`700`).

The API is not stopped for the backup. Every file it writes is written to a temporary file and
renamed into place, so the archive reads whole files.

**Restore test.** Run this on Boop Beep. It never touches the live data:

```bash
sudo deploy/restore-test.sh staging            # newest archive; or pass an archive path
```

The script unpacks the archive into a scratch directory and starts the image that environment is
running now. The container runs on an internal network with no ports and no hostname. The script
reports the number of profiles it finds, then removes everything it created. Run it after
changing anything about backups, and once a month for production.

**Real restore** (production, after deciding to lose changes since the archive). Unpack and
check the archive first, so a bad archive never costs the live data:

```bash
set -euo pipefail
archive=/srv/opengym/production/backups/<archive>.tar.gz
scratch=$(sudo mktemp -d /srv/opengym/restore-XXXXXX)          # root only, same disk
sudo tar -xzf "$archive" -C "$scratch"
sudo test -f "$scratch/backup/opengym-data/db.json"            # stop here if it is not there
# Now stop the opengym-production service in Coolify, then:
sudo mv /srv/opengym/production/data /srv/opengym/production/data.before-restore-$(date +%F-%H%M)
sudo mv "$scratch/backup/opengym-data" /srv/opengym/production/data
sudo chown -R 10001:10001 /srv/opengym/production/data && sudo chmod 700 /srv/opengym/production/data
sudo rm -rf "$scratch"
# Start the service in Coolify, then check <address>/api/health.
```

**Off-host copy: not set up yet.** All archives are on Boop Beep's one disk. If that disk fails,
the backups are lost with it. The only other machines available are Devbox, a laptop and a
desktop, and production data must not live on Devbox. The backup container can also upload to
S3-compatible storage, WebDAV or SSH (its `AWS_*`, `WEBDAV_*` or `SSH_*` settings). An
off-site, encrypted target is a decision for the owner (see the open items in the PR).

## Health, restarts, logs, monitoring

- **Healthchecks.** `api` checks `/api/health`, which writes a probe file into the data
  directory, so a full disk or a read-only mount shows as unhealthy. `web` checks
  `/api/health` through nginx, so it proves the proxy as well. Both check every second while a
  container starts (so deploys and rollbacks see it healthy at once), then every 30 seconds. The
  API runs under an init process, so it stops at once instead of waiting out Docker's 10 s.
  `restart: unless-stopped` brings a crashed container back.
- **Logs.** Coolify, project openGym, the service, then **Logs** for each container. The
  containers' own logs rotate at 5 files of 10 MB each. A failed deploy job prints the container
  `opengym-release` lines and where it stopped. Container logs stay in Coolify, because Actions
  logs in this public repository are public.
- **Monitoring.** `uptime.yml` checks both addresses from outside Boop Beep every 30 minutes
  (joining the tailnet for a tailnet environment), and a
  failure notifies you through GitHub. Production joins once the repository variable
  `PRODUCTION_LIVE` is `true`. Scheduled workflows stop after 60 days without repository
  activity; GitHub emails you before that happens. Coolify Sentinel already reports host CPU,
  memory and disk.

## Production cutover (not done yet)

Production is prepared but has never run: the `opengym-production` service exists in Coolify
and is stopped, and `/srv/opengym/production/{data,backups}` exist and are empty. To bring it up:

1. Merge to `main`. The Tests run deploys staging, then production. Production comes up
   invite-only with no profiles yet.
2. Open signup once: **Deploy an earlier release**, environment `production`, the `run_id` of
   that Tests run, **bootstrap** ticked.
3. With Tailscale on, open <https://boop-beep.tail5728d8.ts.net:8443> at once and create the
   owner profile. The first profile becomes the admin.
4. Close signup: `ssh boop-beep sudo opengym-release rollback production` (back to the
   invite-only release), and check that `<address>/api/config` shows `"invite_only":true`.
5. Pair the iPhone app: on the website, Settings, Account, Pair the mobile app. In the app, enter
   the server address `https://boop-beep.tail5728d8.ts.net:8443` and the code. Tailscale has to
   be on on the phone for it to sync.
6. Set the repository variable `PRODUCTION_LIVE` to `true` (uptime checks), and run
   `sudo deploy/restore-test.sh production` once the first nightly archive exists.

## Passkeys and hostnames

A passkey works only on the exact hostname it was created for (`RP_ID`). `RP_ID` and `ORIGIN`
come from the environment's active address (`exposure` above). On the tailnet, staging and
production share the hostname `boop-beep.tail5728d8.ts.net` on different ports, so a passkey made
on one is offered on the other too. It does not work there, because that server has never seen
it, and it is harmless. Cookies are shared by host too, so each environment names its own session
cookie (`SESSION_COOKIE=gymsid-<env>` in the compose file); you can be signed in to both in one
browser. Changing an environment's address later locks every account out of it.

Both environments start invite-only (`inviteOnly: true`, guests off). A fresh instance has no
admin to issue the first invite, so it needs one release deployed with `--bootstrap` (the
`bootstrap` input of Deploy an earlier release). That deploy turns `INVITE_ONLY` off, and the first profile
created becomes the admin (`FIRST_USER_ADMIN=1`). Create the owner profile at once, then roll back
to the release before it.

## Security boundaries

- Pull requests, including ones from forks, run only on GitHub-hosted runners, with a read-only
  token and no secrets. `publish` and the deploy jobs run only for pushes to this repository.
  Fork pull requests from outside contributors need approval before they run.
- No `pull_request_target` workflow remains. The org's self-hosted runners, two of which run on
  Boop Beep, are not used here, and their runner group does not allow public repositories.
- GitHub holds no Coolify token. Each environment has an SSH key (`DEPLOY_SSH_KEY`, an
  environment secret usable from `main` only) for the user `opengym-deploy` on Boop Beep, whose
  forced command runs `opengym-release --ssh <env>`: the staging key cannot touch production,
  and neither can run anything else (`deploy/host-setup.sh`). The host key is pinned
  (`BOOP_BEEP_KNOWN_HOSTS`). The only Coolify token is in `/etc/opengym/coolify-token`, root only.
- `opengym-release` is installed by hand from a reviewed checkout (`host-setup.sh`), so a commit
  cannot change what runs as root on the host.
- Both environments are tailnet-only: no Coolify domain, no tunnel route, the web container bound
  to `127.0.0.1` on Boop Beep, and `tailscale serve` (never Funnel) in front. The deploy and uptime
  jobs join the tailnet as ephemeral `tag:ci` nodes with an OAuth client
  (`TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, repository secrets, never given to fork pull requests).
  The tailnet policy should let `tag:ci` reach only ports 22, 8443 and 9443 on Boop Beep.
- The GHCR packages are private. The web image carries the Gym visual exercise media, which are
  licensed for use within openGym only (NOTICE.md). Root on Boop Beep is logged in to `ghcr.io`
  to pull them.
- The API runs as uid 10001, which has no account on the host. The Coach (the only part that
  needs root) is disabled (`COACH_DISABLED=1`).

## Licences

openGym is AGPL-3.0-or-later. Anyone who uses our instance over the network is entitled to its
source. This repository is public, and the Settings screen links to the source.

The exercise stills and animations are not AGPL. They are licensed by Gym visual for use within
openGym (NOTICE.md, `catalogue/media/NOTICE.md`). Before a commercial launch, get a licence
from Gym visual, or remove the media.

## One-time setup (already done; redo only to rebuild)

1. On Boop Beep, from a checkout of `main`: `sudo deploy/host-setup.sh staging production`
   (always both: it rewrites the deploy keys and sudo rules). It creates the data and backup
   directories, the `tailscale serve` endpoints, the release tool and the `opengym-deploy` user.
   Before the first run, put a Coolify token (read, write, deploy) in `/etc/opengym/coolify-token`
   and each environment's deploy public key in `/etc/opengym/deploy-<env>.pub`. Rerun it whenever
   `deploy/opengym-release.sh` changes.
2. In Coolify: project **openGym** with environments `staging` and `production`. Create the
   services with `scripts/deploy/coolify.mjs provision <env> release.json` (any valid record;
   the first deploy replaces the images; it needs `COOLIFY_URL`, `COOLIFY_TOKEN`,
   `COOLIFY_PROJECT_UUID` and `COOLIFY_SERVER_UUID`), and write each service's UUID to
   `/srv/opengym/<env>/service-uuid`.
3. In GitHub:
   - environments `staging` and `production`, deployment branches `main` only, each with the
     secret `DEPLOY_SSH_KEY` (the private half of its deploy key);
   - the repository variable `BOOP_BEEP_KNOWN_HOSTS` (`ssh-keyscan -t ed25519
     boop-beep.tail5728d8.ts.net`, checked against the host's own fingerprint);
   - a ruleset on `main` that requires a pull request and the `tests-ok` check.
4. In Tailscale (admin console):
   - in the policy file, `"tagOwners": {"tag:ci": ["autogroup:admin"]}` and a grant that lets
     `tag:ci` reach only what CI needs on Boop Beep:
     `{"src": ["tag:ci"], "dst": ["100.108.36.43"], "ip": ["tcp:22", "tcp:8443", "tcp:9443"]}`.
     If the policy still has the default allow-all rule, tighten it, or `tag:ci` can reach
     everything for the minutes a job runs;
   - Settings, Trust credentials, an OAuth client with the **Auth Keys** write scope and the tag
     `tag:ci`;
   - its ID and secret as repository secrets `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`.

## Syncing with upstream

Upstream lives at DuarteSantos8/openGym. We pull from it and never push or open pull requests
there.

```bash
git remote add upstream https://github.com/DuarteSantos8/openGym.git   # once; fetch only
git fetch upstream && git switch -c sync-upstream origin/main && git merge upstream/main
```

Files this fork deleted come back as modify/delete conflicts: `git rm` them again. Open the
result as a pull request like any other change.

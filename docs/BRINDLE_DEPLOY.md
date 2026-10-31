# Running openGym for Brindle

This is how BrindleHQ/openGym is built, deployed, backed up and released. Upstream's guides
([SELF_HOSTING.md](SELF_HOSTING.md) and the rest) still describe the app itself. This file covers
only our deployment.

## Environments

| | Development | Staging | Production |
|---|---|---|---|
| Where | Devbox | Boop Beep, Coolify project **openGym**, environment `staging` | Boop Beep, Coolify project **openGym**, environment `production` |
| Address | `http://localhost:8080` (compose) or `:5173` (Vite) | <https://opengym-staging.brindle.to> | <https://opengym.brindle.co> |
| Data | `./data` in your checkout | `/srv/opengym/staging/data` | `/srv/opengym/production/data` |
| Backups | none | `/srv/opengym/staging/backups`, nightly 03:17 UTC, 7 days | `/srv/opengym/production/backups`, nightly 02:47 UTC, 30 days |
| Deployed by | you, by hand | every green push to `main`, automatically | `Promote to production`, by hand, with approval |
| Coolify service | none | `opengym-staging` | `opengym-production` |

No two environments share data, hostname, Coolify service, GitHub environment or token.
openGym keeps its own secrets in its data directory: the session key (`secret`) and the push keys
(`vapid.json`). So each environment's secrets live only in that environment's directory.

Nothing that runs in production runs on Devbox, and Devbox holds no production data.

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

Merge when it is green. Nothing else is needed: staging follows.

## Release and promotion

```
pull request ──> Tests (tests-ok)
merge to main ─> Tests ─> publish ──────────> deploy-staging ──────> (you) Promote to production
                          build once, push      same digests,          approve, same digests,
                          to GHCR, smoke-test   verify staging         verify production
                          by digest
```

1. **publish** (in `test.yml`, only after `tests-ok`, only for pushes to this repository) builds
   `ghcr.io/brindlehq/opengym-api` and `opengym-web`, tagged `sha-<commit>`. It pulls them back
   by digest and runs `scripts/deploy/smoke.sh`, then saves `release.json` (the commit and both
   digests) as the run's `release` artifact for 90 days.
2. **deploy-staging** runs `scripts/deploy/coolify.mjs deploy staging release.json`. The script:
   - renders `deploy/coolify-compose.yml` with the values from `deploy/environments.json`;
   - uploads the result to the `opengym-staging` Coolify service and deploys it;
   - waits until the containers report healthy and run the recorded digests;
   - waits until `https://opengym-staging.brindle.to/release.json` names the new commit,
     `/api/health` says the data directory is writable, and `/api/config` shows the rendered
     `invite_only` and `allow_guest`. Until Coolify restarts the containers, the old ones keep
     answering, so checking health alone could pass too early.

   The run summary shows the result and the run ID to promote.
3. **Promote to production** (`promote.yml`): Actions, then **Promote to production**, then
   **Run workflow**, with `run_id` set to that Tests run's ID. The `verify` job refuses anything
   that is not:
   - a green push to `main` in BrindleHQ/openGym,
   - with a successful `deploy-staging` job,
   - whose `release.json` names the same commit.

   The `production` job then waits for the environment's required reviewer. Once approved, it
   checks out the promoted commit and deploys the same two digests with that commit's
   `deploy/` configuration.

Nothing is rebuilt between staging and production. One deploy per environment runs at a time
(`deploy-staging` and `deploy-production` concurrency groups). A second deploy waits and is never
cut off halfway.

A deploy or restart takes the address offline for about 30 to 60 seconds: Coolify stops the
containers before it starts the new ones, and Traefik answers `404` in between. Two copies of the
API cannot run at once on the same data directory, so this gap can't be removed without changing
how openGym stores data. The apps keep their changes and sync once the server is back. Deploy
production when nobody is mid-workout.

### Rolling back

- **Production:** run **Promote to production** with the `run_id` of an earlier Tests run that
  reached staging. It deploys that release's digests and configuration.
- **Staging:** open the earlier Tests run on `main` and re-run its `deploy-staging` job.
- **Older than 90 days** (the release artifact has expired): the images are still in GHCR as
  `sha-<commit>`. Write a `release.json` by hand with the digests from
  `docker buildx imagetools inspect ghcr.io/brindlehq/opengym-api:sha-<commit>`, and run
  `scripts/deploy/coolify.mjs deploy <env> release.json` with the environment's Coolify token.

**An image rollback does not roll back data.** openGym has no schema migrations: the profile is
one JSON document per user, and older code ignores fields it does not know. So a server image can
go back safely. Two things do not go back:

- Data written by a newer app version stays as it was written.
- The iPhone app has its UI built in. Deploying the server never changes the app on a phone.

If a release damaged data, restore a backup instead (below). That also discards every change
made since the backup, on every device that has not synced yet. Prefer the image rollback, and
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
# Start the service in Coolify, then check https://opengym.brindle.co/api/health.
```

**Off-host copy: not set up yet.** All archives are on Boop Beep's one disk. If that disk fails,
the backups are lost with it. The only other machines available are Devbox, a laptop and a
desktop, and production data must not live on Devbox. The backup container can also upload to
S3-compatible storage, WebDAV or SSH (its `AWS_*`, `WEBDAV_*` or `SSH_*` settings). An
off-site, encrypted target is a decision for the owner (see the open items in the PR).

## Health, restarts, logs, monitoring

- **Healthchecks.** `api` checks `/api/health`, which writes a probe file into the data
  directory, so a full disk or a read-only mount shows as unhealthy. `web` checks
  `/api/health` through nginx, so it proves the proxy as well. Both check every 30 seconds.
  `restart: unless-stopped` brings a crashed container back.
- **Logs.** Coolify, project openGym, the service, then **Logs** for each container. The
  containers' own logs rotate at 5 files of 10 MB each. A failed deploy job prints the container
  states and where it stopped. Container logs stay in Coolify, because Actions logs in this
  public repository are public.
- **Monitoring.** `uptime.yml` checks both addresses through Cloudflare every 30 minutes, and a
  failure notifies you through GitHub. Production joins once the repository variable
  `PRODUCTION_LIVE` is `true`. Scheduled workflows stop after 60 days without repository
  activity; GitHub emails you before that happens. Coolify Sentinel already reports host CPU,
  memory and disk.

## Production cutover (not done yet)

Production is prepared but has never run: the `opengym-production` service exists in Coolify
with placeholder images and is stopped, and `/srv/opengym/production/{data,backups}` exist and
are empty. To bring it up:

1. **Make `opengym.brindle.co` resolve.** On 2026-10-31 `brindle.co` was delegated to Linode name
   servers that refuse every query for it, so no record under it resolves. Either:
   - move `brindle.co` to the Cloudflare account that serves `brindle.to`, then add a public
     hostname `opengym.brindle.co` to the existing tunnel, pointing at `http://localhost:80`
     (the same target as `*.brindle.to`); or
   - serve production on a `brindle.to` name instead: change `production.host` in
     `deploy/environments.json` (and the URL in `promote.yml` and `uptime.yml`) in a pull
     request. Do this before step 3. A passkey cannot move hostnames.
2. Merge to `main`, and wait for the Tests run to deploy staging.
3. Run **Promote to production** with that run's ID and **bootstrap** ticked. Approve it.
4. Open <https://opengym.brindle.co> at once and create the owner profile. The first profile
   becomes the admin.
5. Run **Promote to production** again, same run ID, bootstrap off, so the instance is
   invite-only again. Check that `https://opengym.brindle.co/api/config` shows
   `"invite_only":true`.
6. Pair the iPhone app: on the website, Settings, Account, Pair the mobile app. In the app,
   enter the server address `https://opengym.brindle.co` and the code.
7. Set the repository variable `PRODUCTION_LIVE` to `true` (uptime checks), and run
   `sudo deploy/restore-test.sh production` once the first nightly archive exists.

## Passkeys and hostnames

A passkey works only on the exact hostname it was created for (`RP_ID`). `RP_ID` and `ORIGIN`
come from `host` in `deploy/environments.json`. The passkeys made on staging do not work on
production, and changing an environment's `host` later locks every account out of that
environment. Decide the production hostname before the first account is created there.

Both environments start invite-only (`inviteOnly: true`, guests off). A fresh instance has no
admin to issue the first invite, so its first deploy uses `--bootstrap`. The `bootstrap` input of
Promote to production does the same. That deploy turns `INVITE_ONLY` off, and the first profile
created becomes the admin (`FIRST_USER_ADMIN=1`). Create the owner profile at once, then deploy
again without bootstrap.

## Security boundaries

- Pull requests, including ones from forks, run only on GitHub-hosted runners, with a read-only
  token and no secrets. `publish` and the deploy jobs run only for pushes to this repository.
  Fork pull requests from outside contributors need approval before they run.
- No `pull_request_target` workflow remains. The org's self-hosted runners, two of which run on
  Boop Beep, are not used here, and their runner group does not allow public repositories.
- Each Coolify token is stored only in its GitHub environment (`staging` or `production`). The
  token for `staging` can be used only from `main`. The token for `production` can be used only
  from `main`, after the required reviewer approves.

  Coolify scopes tokens to a team, not to a service. So either token could change both services.
  The deploy script refuses to deploy to a service whose name is not `opengym-<env>`.
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

1. On Boop Beep: `sudo deploy/host-setup.sh staging production`.
2. In Coolify: project **openGym** with environments `staging` and `production`. Create the
   services with `scripts/deploy/coolify.mjs provision <env> release.json` (any valid record;
   the first deploy replaces the images). Use a Coolify token with read, write and deploy. It
   needs `COOLIFY_PROJECT_UUID` and `COOLIFY_SERVER_UUID`.
3. In GitHub:
   - the repository variable `COOLIFY_URL`;
   - environments `staging` (deployment branches: `main`) and `production` (deployment
     branches: `main`, required reviewer);
   - in each environment, the variable `COOLIFY_SERVICE_UUID` and the secret `COOLIFY_TOKEN`
     (one token per environment);
   - a ruleset on `main` that requires a pull request and the `tests-ok` check.

## Syncing with upstream

Upstream lives at DuarteSantos8/openGym. We pull from it and never push or open pull requests
there.

```bash
git remote add upstream https://github.com/DuarteSantos8/openGym.git   # once; fetch only
git fetch upstream && git switch -c sync-upstream origin/main && git merge upstream/main
```

Files this fork deleted come back as modify/delete conflicts: `git rm` them again. Open the
result as a pull request like any other change.

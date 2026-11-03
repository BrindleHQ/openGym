# Optional Reppen deployment

`deploy/environments.json` is the authoritative non-secret configuration. Both environments
ship with `reppen.enabled: false`. To enable one, set its `reppen.image` to the actual merged
core image's full `sha256:<64 hex>` Docker image ID (or registry `name@sha256:<64 hex>`),
then set `enabled: true`. Missing pins and mutable tags are rejected. No pin is supplied here:
the rollout owner must build and load the merged core image and record its verified identity.
Images must already exist on the host (`pull_policy: never`); retain previous pins for rollback.
Commit the final non-secret settings so future host installations preserve them.

The normal renderer includes the database, server, worker and backup services on every web
release. No UI edits or temporary compose overrides are needed. Host templates are installed
manually, not overwritten by web CI; reinstalling from a checkout replaces those settings.
Always use the checkout containing the approved enablement/pin when reinstalling.

## Host provisioning (rollout owner only)

From the reviewed checkout on Boop Beep, run `sudo bash deploy/host-setup.sh staging production`.
This installs `deploy/opengym-release.sh` as `/usr/local/bin/opengym-release`, and installs
`deploy/coolify-compose.yml`, `deploy/environments.json`, `deploy/reppen-backup.sh` and
`scripts/deploy/coolify.mjs` under `/usr/local/lib/opengym/` preserving their relative paths.
It creates separate database/backup and protected secret directories. It does not create secrets.
The restore-test script can be run from this checkout; it need not be installed globally.

Provision these three files for each enabled environment using the approved secret channel,
root:root mode 600, under `/etc/opengym/reppen-<env>/` (directory mode 700). Do not put their
values in shell arguments, logs, Git, release records, or Coolify UI variables:

| File | Required contents |
| --- | --- |
| `postgres.env` | `POSTGRES_PASSWORD` |
| `runtime.env` | `REPPEN_DATABASE_URL`, PostgreSQL connection URI for user/database `reppen`, host `reppen-db`, port 5432; URL-encode the password |
| `backup.env` | `PGPASSWORD`, matching the database password |

Use distinct passwords for staging and production. Env-file syntax must quote/escape special
characters correctly. The release tool checks presence, ownership and permissions before
calling Coolify. Changing POSTGRES_PASSWORD after initialization does not rotate the database
role: coordinate SQL role rotation and both clients separately. No secrets go to the web/API.

The renderer derives the issuer from the environment's existing canonical origin and assigns
audience `opengym-staging` or `opengym-production`. API URL is `http://reppen:8080`; JWKS is
`http://api:3000/api/reppen/jwks`; nginx receives `REPPEN_BACKEND=reppen:8080`. There are no
published database/server ports. Existing profile mounts, cookie names, passkey origins,
invite-only flags and guest policy are preserved.

After provisioning and loading the image, deploy through the normal release command:
`sudo opengym-release deploy staging < release.json`. Verify staging enrollment, logging,
worker completion, account isolation, restore and rollback before enabling production. Publish
the sealed catalog through the core publisher separately; wiring alone does not publish a
program or enroll accounts. Never invent user setup values.

## Backups and restoration

PGDATA persists at `/srv/opengym/<env>/reppen/postgres`. The existing OpenGym tar archive
contains API files only; it is **not** a PostgreSQL backup. `reppen-backup` takes a consistent
custom-format `pg_dump` at startup and every 24 hours, validates its table of contents, then
atomically publishes it under `/srv/opengym/<env>/reppen/backups`. Retention follows that
environment's existing retention days. Failures leave the last good dump intact, exit/restart
the service and eventually fail its freshness healthcheck. Deployment waits for a fresh dump.
These are local backups; arrange separate protected off-host copies for host-loss recovery.

For an immediate checkpoint on the host (replace ENV with staging or production):

```sh
uuid=$(sudo cat /srv/opengym/ENV/service-uuid)
sudo docker exec "reppen-backup-$uuid" sh /opt/reppen-backup.sh --once
sudo bash deploy/reppen-restore-test.sh /srv/opengym/ENV/reppen/backups/CHOSEN.dump
sudo bash deploy/restore-test.sh ENV
```

Manual and scheduled dumps use unique temporary/output names. The restore test starts disposable PG17
with no network or live mounts, restores in a single transaction and reports table counts.
Compare counts to the checkpoint, then validate core reads against a restored copy before
acceptance. The test removes its disposable database; it never restores onto live PGDATA.

For a coordinated recovery point, stop API/server/worker writers before taking both the API
archive and PG dump. Independently timed snapshots are not a cross-store atomic backup.
Preserve API signing keys and profiles alongside PostgreSQL enrollment/workout data.

## Rollback limits

Normal web deployments leave the database path, core pin and protected env files unchanged.
Release snapshots retain the rendered core pin and service definitions, but reference the
current host secret files and backup script. Keep compatible versions of those host files.
Reppen runs migrations on startup: an image rollback does **not** undo schema/data changes.
Prove backward schema compatibility before rolling core back, or stop writers and restore a
matched database/API checkpoint to separate paths first, validate, then perform an explicit
maintenance cutover. Never automatically replace live PGDATA during web rollback.

A rollback to a snapshot from before Reppen activation removes its containers (including the
backup service) and disables the proxy, while the bind-mounted database/dumps remain. This
is expected but suspends managed workouts; re-enable using an approved current plan. Do not
delete the Reppen directories or use volume cleanup as rollback. Take a coordinated backup
before initial activation and each core upgrade. The rollout owner must prove Coolify accepts
the absolute protected env-file paths and preserves the locally loaded image pin in staging.

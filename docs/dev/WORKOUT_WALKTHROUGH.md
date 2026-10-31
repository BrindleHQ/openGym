# One workout, end to end

This note follows one operation, "finish a workout", from the tap on the phone to the file on
Boop Beep and the nightly backup. It also shows where each step is tested and how the step gets
built and deployed. Line numbers are from the commit that added this file. If they have moved,
search for the function name.

## 1. The tap: an in-memory session becomes a saved workout

While you train, the session lives in `S.active`. That is device-local state in the Zustand
store, and it is never sent to the server (see step 4).

When you tap Finish, `doFinishWorkout` in `frontend/src/sheets.jsx:3737` runs. It does three
things:

- It works out personal records (PRs) against your history.
- It calls `buildCompletedWorkout` (`frontend/src/lib/finish-workout.js:69`). That is a pure
  function: it keeps only the logged sets, gives each exercise its best weight, and works out
  the end time with `sessionEnd`, so a session you forgot to close does not run for hours.
- It writes the result inside one store update: `s.workouts.push(w)`, then `s.active = null`
  (`sheets.jsx:3782`).

Pure helpers like this are where the training logic lives (CONTRIBUTING.md). They are tested
without a browser: `frontend/src/lib/finish-workout.test.js` (run with `cd frontend && npx vitest
run src/lib/finish-workout.test.js`).

## 2. Persisting on the device, then a debounced push

Every store `update` saves the state to `localStorage` (`gym_state_v1`). On the phones it also
saves it to a file (`nativePersist`), because the operating system can empty WebView storage.

When you are signed in, the update also schedules a push 1.5 seconds later
(`frontend/src/store/useStore.js:676`). The delay means a burst of edits goes out as one request.
If the app is still starting up, the push waits until the first pull has finished (`finishBoot`).
Otherwise an old copy could be pushed over a newer one.

## 3. The request: one document, with the revision it came from

`doPush` (`useStore.js:764`) sends the whole profile as one JSON document:

```
PUT /api/data
{ "state": { ...workouts, routines, settings... }, "baseRev": 41, "baseWid": "..." }
```

The request goes through `api()` in `frontend/src/lib/api.js:60`, the only file that talks to the
server. In a browser, the session cookie identifies you. A paired phone sends the same session as
a bearer token. `baseRev` is the server revision this copy was built on, and `baseWid` is the ID
of that write. The route is documented in `api/openapi.yaml`, and `api/test/openapi-routes.test.js`
fails if the spec and the routes in `server.js` stop matching.

## 4. The server: compare, then write atomically

The browser loads the app from nginx in the web container, and nginx forwards `/api/` to the api
container (`web/nginx.conf.template`, `location ^~ /api/`). In staging and production, `tailscale
serve` on Boop Beep comes before nginx, or Cloudflare and Traefik for a public environment.

`routes['PUT /api/data']` (`api/server.js:2472`) handles the request. The server is plain
`node:http` with a table of routes, and there is no framework.

1. The request must have a session, and the document must look like a profile. An empty `{}` is
   refused, so a bug cannot wipe your data.
2. **The concurrency check** (`server.js:2515`). The server reads the stored document. If
   `baseRev` is not the current `_rev`, another device has written since this one last read. The
   server answers `409` and sends the current document back with it. Because the read and the
   write run with nothing awaited between them, nothing can slip in between.
3. `delete body.state.active` removes the in-progress session. It stays on the device.
4. **The write** (`server.js:2553`): `atomicWrite(stateFile(uid), text)` from `api/durable.js:28`.
   The server writes a `.tmp` file, flushes it to disk (`fsync`), renames it over
   `state-<uid>.json`, and then flushes the directory. A power cut leaves either the old file or
   the new one, never half of each. That is also why the backup can copy the directory while the
   server runs.
5. The response carries `rev: n+1` and the new write ID. The client stores them as the base for
   its next push.

The tests start the real server on a temporary data directory and send real HTTP requests:
`api/test/server-data-rev.test.js` covers revisions, the 409 and the old overwrite path. Run it
with `cd api && node --test test/server-data-rev.test.js`.

## 5. Sync: the 409 is the merge

Say you finished on the phone while the laptop had changed a setting. The phone's push gets a
409. `doPush` (`useStore.js:799`) merges its copy with the document that came back with the 409
(`mergeInto`, then `mergeStates` from `frontend/src/lib/sync-merge.js:806`), and pushes once more
against that revision.

Workouts are merged by ID, so both sides keep their workouts. Settings and maps are merged per
field by timestamp (`_ts`), so the newest edit of each field wins. Deletions are recorded, so a
deleted item stays deleted.

The server applies the same stamping rules in `api/sync-stamps.js`, a hand-copied twin of the
frontend rules. `api/test/sync-stamps.test.js` checks that the two agree. The merge itself has
example tests and property tests (`sync-merge.test.js`, `sync-merge.property.test.js`).

## 6. On disk, and in the backup

On staging, the file is `/srv/opengym/staging/data/state-<uid>.json` on Boop Beep. It is owned by
uid 10001, the user the api container runs as (`deploy/coolify-compose.yml`). Each night the
`backup` container archives the whole data directory into `/srv/opengym/staging/backups/`, and
`deploy/restore-test.sh` proves an archive boots (see [BRINDLE_DEPLOY.md](../BRINDLE_DEPLOY.md)).

## 7. How this code reached the server

1. You open a pull request. `.github/workflows/test.yml` runs the suites above, builds both images
   and boots them together (the `images` job). `tests-ok` is the required check.
2. You merge. On `main`, `publish` builds the images once, pushes them to GHCR and smoke-tests them
   by digest (`scripts/deploy/smoke.sh`). It records the two digests in `release.json`.
3. `deploy-staging` (`.github/workflows/deploy.yml`) renders a plan for staging
   (`scripts/deploy/coolify.mjs plan`: `deploy/coolify-compose.yml` filled in, plus what the
   release must show when live) and sends it over the tailnet to `opengym-release` on Boop Beep.
   The tool has Coolify start it, waits for the new containers to serve the new commit at
   `https://boop-beep.tail5728d8.ts.net:9443`, and keeps a snapshot for rollback.
4. `deploy-production` does the same for production, right after staging took the release.
   `ssh boop-beep sudo opengym-release rollback production` goes back in about 4 seconds.

To watch a single push happen, open the browser's network tab while you finish a workout on
staging. One `PUT /api/data` appears about 1.5 seconds later, and its response carries the new
`rev`.

# OpenGym agent CLI

Use OpenGym from an agent's shell without installing an MCP server. Requires Node 22+ and this checkout; no npm install is needed for the CLI. It shares the existing HTTP client and actual session builder. The optional project skill is `.agents/skills/opengym/SKILL.md`.

```sh
node bin/opengym --help
node bin/opengym exercises search --query 'dumbbell bench press' --limit 5
```

## Pair once

In the signed-in app, use Settings → Account → Pair the mobile app. Supply the one-use code through your agent host's private secret/file mechanism:

```sh
node bin/opengym auth pair --url https://gym.example.com \
  --code-file /private/pairing-code --out /private/opengym-token
export OPENGYM_URL=https://gym.example.com
export OPENGYM_TOKEN_FILE=/private/opengym-token
```

The token file is created exclusively with mode 0600. An existing file is refused before consuming the code. Remove the code file using the host's secret-file lifecycle. `OPENGYM_TOKEN` is accepted for existing integrations. `OPENGYM_UID` optionally pins the account. The token is a full-profile paired-phone session, with the same expiration; Sign out everywhere revokes it. No SSH, database access or server signing key is needed. HTTPS is required except on loopback; redirects are refused.

## Read and preview

```sh
node bin/opengym whoami
node bin/opengym routines list --limit 20 --offset 0
node bin/opengym routines get --id upper-a
node bin/opengym session preview --routine upper-a
```

Results are compact JSON; lists are paginated (maximum 50). A routine read reports stored targets. A session preview reports the engine's decision/reason and actual opening set rows, including warm-ups and history-driven loads. It previews one routine now, not a future forecast, combined multi-routine session, or workout already in progress. It writes no workouts or progression state.

## Routine input

Write a plan file with stable routine IDs that you own. An existing ID updates that routine; a new ID adds one. This version authors rep-based exercises using existing catalogue or profile custom-exercise IDs. Timed/cardio authoring and creating custom exercises remain in the app.

```json
{
  "opengym_plan": 1,
  "unit": "lb",
  "routines": [{
    "id": "upper-a", "name": "Upper A", "prog": "double",
    "ex": [{
      "id": "0289", "sets": 4, "repsMin": 8, "reps": 12,
      "weight": 65, "dbLoad": "each", "restSec": 120
    }]
  }],
  "week": {"1": ["upper-a"], "3": []}
}
```

`reps` is the range ceiling. The required `unit` applies to `weight` and optional load `inc`; these are converted into the profile's unit with OpenGym's conversion rules. Existing profile units and history stay unchanged. An empty profile starts in the input unit. Missing weights are not guessed: the app may use history or zero. `dbLoad` is `each`, `total`, or `as` for dumbbells/kettlebells. Use `bodyweight: true` for bodyweight work.

Exercise fields: `id`, `sets`, `reps`, `repsMin`, `weight`, `restSec`, `prog`, `inc`, `dbLoad`, `bodyweight`, `note`. Routine fields: `id`, `name`, `emoji`, `prog`, `excludeFromProgression`, `ex`. Unknown fields and unsupported quantities are refused. Updating a routine replaces its exercise list; inspect removed fields/exercises in the diff. Native routine metadata is retained. Weight-only edits below retain all native exercise configuration.

The optional `week` is a day patch: 0=Sunday through 6=Saturday. Arrays contain routine IDs; an empty array makes that day a rest day. Unmentioned weekdays stay unchanged. Omitting `week` leaves the schedule unchanged. This edits the weekly grid, not rotations, floating queues, or individual date overrides.

```sh
node bin/opengym plan preview --file plan.json --out change.json
node bin/opengym plan apply --file change.json
```

Preview prints the changes and writes a private, exclusive change file rather than a full profile. The file binds exact prior/next routines to the server, account, revision, write ID and unit. Its checksum detects accidental edits; it is not an authorization signature. Treat the file as private training data. Edit the input and preview to a new output path to change a proposal.

Apply re-reads the profile, checks the binding, makes one conditional API write, then verifies affected fields by read-back. Other routines, history, weigh-ins and preferences remain intact. A no-op makes no write. Concurrent edits or a restored backup invalidate the proposal, even when a restored revision counter matches. Re-preview on `ECONFLICT` rather than forcing stale changes. On `EVERIFY`, inspect the current state before retrying: the write may already have succeeded.

## Starting-weight input

Read the routine, then use its ID and one-based exercise position. The prepared file binds positions to the exact profile revision.

```json
{
  "unit": "lb",
  "updates": [{
    "routine_id": "upper-a", "position": 1,
    "weight": 65, "reported_reps": 12, "dbLoad": "each"
  }]
}
```

```sh
node bin/opengym weights preview --file weights.json --out weight-change.json
node bin/opengym plan apply --file weight-change.json
```

`reported_reps` is optional reference information, never a workout log. A reference below the prescribed floor returns `ETARGET`. Clarify whether it was a limit or an old target. When the user explicitly still wants that load, set `acknowledge_rep_mismatch: true` on that update. The CLI does not estimate a replacement weight. Omit unknown weights. Existing notes, warm-ups and other exercise settings are preserved.

## Errors and limits

Errors are JSON on stdout, with no stack traces or credential values. Exit status: 2=input/rep-target error, 3=conflict, 4=rejected authentication, 1=other failures. Input files are limited to 1 MiB, plans to 30 routines and 40 exercises each, weight batches to 200 entries. Apply is an explicit mutation with no interactive confirmation prompt.

This release supports v1 profiles and refuses a different `engineSchemaVersion`. Multiweek forecasts, arbitrary question-driven rules, deleting routines, log corrections and in-app setup screens are separate features. The MCP bridge remains usable alongside this CLI. Token savings depend on host discovery, help loaded, outputs and retries; no measured percentage is claimed.

## Verification

```sh
cd api && npm ci --omit=optional && cd ..
node --test agent/*.test.js
```

Tests exercise the actual API server, profile preservation, real training previews, private output files, idempotent plans, conversions, invalid proposals, stale and racing writes. CI runs them in the MCP job, which already installs API dependencies.

---
name: opengym
description: Inspect OpenGym routines, preview workout prescriptions, and create or update routines, schedules, and starting weights through the CLI.
---

Run `node bin/opengym --help` from the OpenGym checkout. Use compact JSON results; keep full profiles and credentials outside model context. Read [the CLI guide](../../../docs/AGENT_CLI.md) for input formats or pairing setup.

1. Run `whoami` and verify the intended server and profile. Use existing paired credentials via `OPENGYM_TOKEN_FILE`; request missing secrets through the host's private credential mechanism. Keep tokens and pairing codes out of chat and arguments.
2. Use `routines list`, `routines get`, and `exercises search` to resolve IDs. Use `session preview` before stating what a workout will open with: history and progression can override stored targets.
3. Write a plan file for routine changes or a weights file for starting loads. Specify units and per-hand versus total dumbbell meaning. Treat reported performances as references, not completed workouts. Clarify below-range references before setting `acknowledge_rep_mismatch`.
4. Run `plan preview` or `weights preview` to prepare an exclusive change file and inspect its diff. Apply changes within the user's requested scope with `plan apply`. On `ECONFLICT`, re-read the profile and prepare a fresh diff. On `EVERIFY`, inspect current data before retrying: the write may have succeeded.
5. Report the verified revision and affected routines. Distinguish stored targets, actual opening sets, and logged history. Keep workload adaptations as coaching notes unless the app actually executes them.

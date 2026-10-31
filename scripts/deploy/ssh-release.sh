#!/usr/bin/env bash
# Runs one opengym-release command on Boop Beep from a deploy job, over the tailnet, with the
# environment's own key: that key can do nothing but `opengym-release <cmd> <env>` there
# (deploy/host-setup.sh). stdin is passed through (a deploy reads its plan from it). Prints the
# tool's JSON lines and exits non-zero unless the last one says "ok": true.
#
#   DEPLOY_SSH_KEY=... BOOP_BEEP_KNOWN_HOSTS=... scripts/deploy/ssh-release.sh deploy staging < plan.json
set -euo pipefail
: "${DEPLOY_SSH_KEY:?the environment's DEPLOY_SSH_KEY secret}"
: "${BOOP_BEEP_KNOWN_HOSTS:?the BOOP_BEEP_KNOWN_HOSTS variable (pinned host key)}"
host=${BOOP_BEEP_HOST:-boop-beep.tail5728d8.ts.net}

dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
printf '%s\n' "$DEPLOY_SSH_KEY" > "$dir/key"; chmod 600 "$dir/key"
printf '%s\n' "$BOOP_BEEP_KNOWN_HOSTS" > "$dir/known_hosts"

out=$dir/out
set +e
ssh -i "$dir/key" -o IdentitiesOnly=yes -o UserKnownHostsFile="$dir/known_hosts" -o StrictHostKeyChecking=yes \
  -o ConnectTimeout=20 -o BatchMode=yes "opengym-deploy@$host" "$@" | tee "$out"
rc=${PIPESTATUS[0]}
set -e
if [ "$rc" = 255 ] && [ ! -s "$out" ]; then
  echo "::error::could not reach opengym-deploy@$host over SSH; the tailnet policy has to let tag:ci reach tcp:22 on Boop Beep"
  exit 1
fi
tail -1 "$out" | jq -e '.ok == true' >/dev/null || { echo "::error::opengym-release $*: $(tail -1 "$out" | jq -r '.error // "failed"')"; exit 1; }

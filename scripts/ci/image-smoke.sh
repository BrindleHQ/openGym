#!/usr/bin/env bash
set -euo pipefail

# The runner may itself be a container using the host's Docker socket.
# Probe from inside Docker's network instead of the runner's localhost.
network="og-smoke-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:-1}"
api="$network-api"
web="$network-web"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker logs "$api" 2>&1 || true
    docker logs "$web" 2>&1 || true
  fi
  docker rm -f "$web" "$api" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  return "$status"
}
trap cleanup EXIT

docker network create "$network"
docker run -d --name "$api" --network "$network" --network-alias api \
  -e DATA_DIR=/data opengym-api:default
api_ready() {
  docker exec "$api" node -e '
    fetch("http://127.0.0.1:3000/api/config").then(async r => {
      if (!r.ok || !Object.hasOwn(await r.json(), "invite_only")) process.exit(1)
    }).catch(() => process.exit(1))'
}
for _ in $(seq 1 30); do api_ready >/dev/null 2>&1 && break; sleep 1; done
api_ready
docker run --rm opengym-api:default node -e \
  'import("@anthropic-ai/claude-agent-sdk").then(()=>{console.error("AI runtime present in the default image");process.exit(1)},()=>process.exit(0))'

docker run -d --name "$web" --network "$network" --network-alias web opengym-web:ci
web_ready() {
  docker exec "$api" node --input-type=module -e '
    const page = await fetch("http://web/");
    if (!page.ok || !(await page.text()).includes("id=\"root\"")) process.exit(1);
    const config = await fetch("http://web/api/config");
    if (!config.ok || !Object.hasOwn(await config.json(), "invite_only")) process.exit(1);'
}
for _ in $(seq 1 30); do web_ready >/dev/null 2>&1 && break; sleep 1; done
web_ready

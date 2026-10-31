#!/usr/bin/env bash
# Pulls the two images a release record names, by digest, and starts them the way
# deploy/coolify-compose.yml does: the API as uid 10001 on a data directory it owns, nginx on
# 8080 proxying /api to it. Then checks what staging and production depend on.
#
#   scripts/deploy/smoke.sh release.json
set -euo pipefail

rel=${1:?usage: smoke.sh release.json}
field() { node -p "require(process.argv[1])['$1']" "$(realpath "$rel")"; }
sha=$(field sha)
api=$(field api)
web=$(field web)
id=og-smoke-$$
port=${SMOKE_PORT:-18080}
data=$(mktemp -d)

cleanup() {
  docker rm -f "$id-web" "$id-api" >/dev/null 2>&1 || true
  docker network rm "$id" >/dev/null 2>&1 || true
  # The directory belongs to 10001 by now; remove it as root from inside a container.
  docker run --rm --user 0 --entrypoint sh -v "$data:/d" "$api" -c 'rm -rf /d/* /d/.[!.]*' 2>/dev/null || true
  rmdir "$data" 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "::error::smoke: $*"; docker logs "$id-api" 2>&1 | tail -20 || true; docker logs "$id-web" 2>&1 | tail -20 || true; exit 1; }

docker image inspect "$api" >/dev/null 2>&1 || docker pull -q "$api" >/dev/null
docker image inspect "$web" >/dev/null 2>&1 || docker pull -q "$web" >/dev/null
docker run --rm --user 0 --entrypoint chown -v "$data:/d" "$api" 10001:10001 /d
docker network create "$id" >/dev/null
docker run -d --name "$id-api" --network "$id" --network-alias api --user 10001:10001 \
  -e DATA_DIR=/data -e RP_ID=localhost -e "ORIGIN=http://localhost:$port" -e COACH_DISABLED=1 \
  -e FIRST_USER_ADMIN=1 -e INVITE_ONLY=1 -e ALLOW_GUEST=0 -e TRUST_PROXY=1 \
  -v "$data:/data" "$api" >/dev/null
docker run -d --name "$id-web" --network "$id" -e NGINX_PORT=8080 -e BACKEND=api -e PORT=3000 \
  -e 'CF_CONNECTING_IP=$http_cf_connecting_ip' -p "127.0.0.1:$port:8080" "$web" >/dev/null

base=http://127.0.0.1:$port
for _ in $(seq 1 30); do curl -fsS "$base/api/health" >/dev/null 2>&1 && break; sleep 1; done

curl -fsS "$base/" | grep -q 'id="root"' || fail "the app shell is not served"
served=$(curl -fsS "$base/release.json" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).revision') \
  || fail "release.json is missing"
[ "$served" = "$sha" ] || fail "release.json says $served, the record says $sha"
curl -fsS "$base/api/health" | grep -q '"writable":true' || fail "the API cannot write its data directory"
curl -fsS "$base/api/config" | grep -q '"invite_only":true' || fail "INVITE_ONLY did not reach the API"
owner=$(docker exec "$id-api" stat -c '%u %a' /data/secret) || fail "no session secret in /data"
[ "$owner" = "10001 600" ] || fail "/data/secret is '$owner', want '10001 600'"
docker exec "$id-api" node -e 'import("@anthropic-ai/claude-agent-sdk").then(()=>process.exit(1),()=>process.exit(0))' \
  || fail "the API image carries the Coach runtime"
docker exec "$id-web" grep -q 'http_cf_connecting_ip' /etc/nginx/conf.d/default.conf \
  || fail "nginx did not get CF_CONNECTING_IP"

echo "smoke ok: $sha"
echo "  $api"
echo "  $web"

#!/usr/bin/env bash
# Proves a backup can be restored, without touching the environment it came from. Run as root
# on Boop Beep:
#
#   sudo deploy/restore-test.sh staging                 newest staging archive
#   sudo deploy/restore-test.sh staging <archive.tar.gz>
#
# Unpacks the archive into a fresh directory under /srv/opengym/restore-test-*, starts the API
# image the environment is running right now on that copy, on its own network with no port
# published and no domain, and asks it how many profiles it holds. Then removes everything it
# made. It never writes to /srv/opengym/<env>/data.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
env=${1:?usage: restore-test.sh <env> [archive]}
case "$env" in staging|production) ;; *) echo "unknown environment: $env" >&2; exit 2 ;; esac
archive=${2:-$(ls -1t "/srv/opengym/$env/backups"/opengym-"$env"-*.tar.gz 2>/dev/null | head -1)}
[ -f "$archive" ] || { echo "no archive found for $env" >&2; exit 1; }

# The API container of this environment: the running one that mounts its data at /data.
live=$(docker ps -q | xargs -r docker inspect --format '{{.Name}} {{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' \
  | awk -v m="/srv/opengym/$env/data:/data " 'index($0" ", m) {sub(/^\//, "", $1); print $1; exit}')
[ -n "$live" ] || { echo "no running $env api container" >&2; exit 1; }
image=$(docker inspect "$live" --format '{{.Config.Image}}')
users_live=$(docker exec "$live" wget -qO- http://127.0.0.1:3000/api/health | sed -E 's/.*"users":([0-9]+).*/\1/')

id=opengym-restore-test-$(date +%s)
dir=/srv/opengym/$id
cleanup() { docker rm -f "$id" >/dev/null 2>&1 || true; docker network rm "$id" >/dev/null 2>&1 || true; rm -rf "$dir"; }
trap cleanup EXIT

install -d -m 700 "$dir"
tar -xzf "$archive" -C "$dir"
data="$dir/backup/opengym-data"
[ -f "$data/db.json" ] || { echo "archive has no backup/opengym-data/db.json" >&2; exit 1; }
chown -R 10001:10001 "$data"
files=$(find "$data" -type f | wc -l)

docker network create --internal "$id" >/dev/null
docker run -d --name "$id" --network "$id" --user 10001:10001 -e DATA_DIR=/data -e COACH_DISABLED=1 \
  -e RP_ID=restore-test.invalid -e ORIGIN=https://restore-test.invalid -v "$data:/data" "$image" >/dev/null
health=""
for _ in $(seq 1 30); do
  health=$(docker exec "$id" wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null) && break
  sleep 1
done
echo "$health" | grep -q '"writable":true' || { echo "restored instance is not healthy: ${health:-no answer}" >&2; docker logs "$id" | tail -20; exit 1; }
users=$(echo "$health" | sed -E 's/.*"users":([0-9]+).*/\1/')
states=$(find "$data" -maxdepth 1 -name 'state-*.json' | wc -l)

echo "restore test ($env) ok"
echo "  archive:  $archive ($(du -h "$archive" | cut -f1), $files files)"
echo "  image:    $image"
echo "  profiles: $users restored, $users_live live now; $states state files"

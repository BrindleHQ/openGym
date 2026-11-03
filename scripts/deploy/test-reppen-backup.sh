#!/usr/bin/env bash
# Local synthetic integration test; no live paths, passwords, or external connections.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
image=postgres:17.11@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1
id=opengym-backup-test-$$
dir=$(mktemp -d)
trap 'docker rm -fv "$id" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
docker run -d --name "$id" --network none --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=reppen -e POSTGRES_DB=reppen \
  -e PGUSER=reppen -e PGDATABASE=reppen -e RETENTION_DAYS=7 \
  -v "$dir:/archive" -v "$root/deploy/reppen-backup.sh:/backup.sh:ro" "$image" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$id" pg_isready -h 127.0.0.1 -U reppen -d reppen >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$id" psql -U reppen -d reppen -v ON_ERROR_STOP=1 -c 'CREATE TABLE backup_fixture (id integer PRIMARY KEY); INSERT INTO backup_fixture VALUES (42);' >/dev/null
docker exec "$id" sh /backup.sh --once
docker exec "$id" chown -R "$(id -u):$(id -g)" /archive
archive=$(find "$dir" -name '*.dump')
[ -s "$archive" ]
[ -z "$(find "$dir" -name '.dump.*')" ]
bash "$root/deploy/reppen-restore-test.sh" "$archive"
# A connection failure must not publish an archive or remove the previous good one.
before=$(sha256sum "$archive")
if docker exec -e PGHOST=127.0.0.1 -e PGPORT=1 "$id" sh /backup.sh --once 2>/dev/null; then
  echo 'backup unexpectedly succeeded with a closed database port' >&2; exit 1
fi
[ "$before" = "$(sha256sum "$archive")" ]
[ -z "$(find "$dir" -name '.dump.*')" ]
echo 'Backup success, isolated restore and failure preservation passed.'

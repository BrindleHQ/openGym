#!/usr/bin/env bash
# Restore into a disposable PostgreSQL with no network or production mounts.
set -euo pipefail
archive=${1:?usage: reppen-restore-test.sh <backup.dump>}
[ -s "$archive" ] || { echo 'missing dump' >&2; exit 1; }
image=postgres:17.11@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1
id=opengym-reppen-restore-$(date +%s)-$$
trap 'docker rm -fv "$id" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$id" --network none --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=reppen -e POSTGRES_DB=reppen "$image" >/dev/null
ready=false
for _ in $(seq 1 60); do
  if docker exec "$id" pg_isready -U reppen -d reppen >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ] || { echo 'isolated PostgreSQL did not start' >&2; exit 1; }
docker exec -i "$id" pg_restore -U reppen -d reppen --exit-on-error --single-transaction --no-owner --no-acl < "$archive"
# Counts only: never print restored account/workout data. Compare with the backup checkpoint.
docker exec -i "$id" psql -X -U reppen -d reppen -v ON_ERROR_STOP=1 <<'SQL'
SELECT format('SELECT %L AS table_name, count(*) AS rows FROM %I.%I;', tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
\gexec
SQL
echo 'Isolated PostgreSQL restore passed; disposable database removed on exit.'

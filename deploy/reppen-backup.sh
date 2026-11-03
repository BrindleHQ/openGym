#!/bin/sh
# Logical, transaction-consistent PostgreSQL backup; never archive live PGDATA.
set -eu
umask 077
case "${RETENTION_DAYS:-}" in ''|*[!0-9]*) exit 2;; esac
[ "$RETENTION_DAYS" -gt 0 ] || exit 2
mkdir -p /archive
tmp=
trap '[ -z "$tmp" ] || rm -f "$tmp"' EXIT
while :; do
  tmp=$(mktemp /archive/.dump.XXXXXX)
  pg_dump --no-owner --no-acl --format=custom --file="$tmp"
  pg_restore --list "$tmp" >/dev/null
  mv "$tmp" "/archive/reppen-$(date -u +%Y-%m-%dT%H-%M-%S)-${tmp##*.}.dump"
  tmp=
  find /archive -name 'reppen-*.dump' -mtime +"$RETENTION_DAYS" -delete
  [ "${1:-}" != --once ] || exit 0
  sleep 86400 &
  wait $!
done

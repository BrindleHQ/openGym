#!/usr/bin/env bash
# One-time setup on Boop Beep for the openGym environments (run with sudo). Idempotent.
#
#   sudo deploy/host-setup.sh staging production
#
# /srv/opengym/<env>/data     the API's DATA_DIR: owned by uid 10001 (no host account), mode 700
# /srv/opengym/<env>/backups  nightly archives from the backup container: root only, mode 700
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ $# -gt 0 ] || { echo "usage: host-setup.sh <env>..." >&2; exit 2; }
install -d -m 755 -o root -g root /srv/opengym
for env in "$@"; do
  case "$env" in staging|production) ;; *) echo "unknown environment: $env" >&2; exit 2 ;; esac
  install -d -m 755 -o root -g root "/srv/opengym/$env"
  install -d -m 700 -o 10001 -g 10001 "/srv/opengym/$env/data"
  install -d -m 700 -o root -g root "/srv/opengym/$env/backups"
done
find /srv/opengym -maxdepth 2 -printf '%M %u:%g %p\n' | sort -k3

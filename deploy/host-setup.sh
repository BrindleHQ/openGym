#!/usr/bin/env bash
# Setup on Boop Beep for the openGym environments. Run with sudo from a checkout of main, and
# again whenever deploy/opengym-release.sh changes: CI cannot change what runs as root here.
# Idempotent.
#
#   sudo deploy/host-setup.sh staging production
#
# Per environment:
#   /srv/opengym/<env>/data          the API's DATA_DIR: owned by uid 10001 (no host account), mode 700
#   /srv/opengym/<env>/backups       nightly archives from the backup container: root only, mode 700
#   /srv/opengym/<env>/service-uuid  the Coolify service (written once, after provisioning)
#   tailscale serve                  HTTPS on https://<tailnet.host>:<tailnet.port>, tailnet only
#   /etc/opengym/deploy-<env>.pub    optional: the public key GitHub deploys <env> with
# Once:
#   /usr/local/bin/opengym-release   the release tool (deploy/opengym-release.sh), root-owned
#   /usr/local/lib/opengym           what it renders each environment from: the compose template,
#                                    deploy/environments.json and the renderer, from this checkout
#   /etc/opengym/coolify-token       a Coolify API token (read, write, deploy), root only
#   user opengym-deploy              can only run `opengym-release --ssh <env>`, one env per key
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ $# -gt 0 ] || { echo "usage: host-setup.sh <env>..." >&2; exit 2; }
envs=deploy/environments.json
[ -f "$envs" ] || { echo "run from the repository root ($envs not found)" >&2; exit 2; }

install -d -m 755 -o root -g root /srv/opengym
install -d -m 700 -o root -g root /etc/opengym
install -m 755 -o root -g root deploy/opengym-release.sh /usr/local/bin/opengym-release
install -d -m 755 -o root -g root /usr/local/lib/opengym/deploy /usr/local/lib/opengym/scripts/deploy
install -m 644 -o root -g root deploy/coolify-compose.yml deploy/environments.json /usr/local/lib/opengym/deploy/
install -m 644 -o root -g root scripts/deploy/coolify.mjs /usr/local/lib/opengym/scripts/deploy/
docker pull -q "$(sed -n 's/^NODE_IMAGE=//p' deploy/opengym-release.sh)" >/dev/null
[ -s /etc/opengym/coolify-token ] || echo "warning: /etc/opengym/coolify-token is missing; opengym-release needs it" >&2

id opengym-deploy >/dev/null 2>&1 || useradd --system --create-home --shell /bin/sh opengym-deploy
passwd -l opengym-deploy >/dev/null
install -d -m 700 -o opengym-deploy -g opengym-deploy ~opengym-deploy/.ssh
keys=$(mktemp); sudoers=$(mktemp); trap 'rm -f "$keys" "$sudoers"' EXIT
# sudo drops the environment, and the request arrives in SSH_ORIGINAL_COMMAND: keep that one.
echo 'Defaults!/usr/local/bin/opengym-release env_keep += "SSH_ORIGINAL_COMMAND"' > "$sudoers"

for env in "$@"; do
  case "$env" in staging|production) ;; *) echo "unknown environment: $env" >&2; exit 2 ;; esac
  install -d -m 755 -o root -g root "/srv/opengym/$env"
  install -d -m 700 -o 10001 -g 10001 "/srv/opengym/$env/data"
  install -d -m 700 -o root -g root "/srv/opengym/$env/backups"
  [ -s "/srv/opengym/$env/service-uuid" ] || echo "warning: /srv/opengym/$env/service-uuid is missing" >&2
  port=$(jq -er ".$env.tailnet.port" "$envs")
  local_port=$(jq -er ".$env.localPort" "$envs")
  # Serve, never Funnel: Funnel would put it on the public internet.
  tailscale serve --bg --https="$port" "http://127.0.0.1:$local_port" >/dev/null
  if [ -s "/etc/opengym/deploy-$env.pub" ]; then
    printf 'restrict,command="sudo -n /usr/local/bin/opengym-release --ssh %s" %s\n' "$env" "$(head -1 "/etc/opengym/deploy-$env.pub")" >> "$keys"
  fi
  printf 'opengym-deploy ALL=(root) NOPASSWD: /usr/local/bin/opengym-release --ssh %s\n' "$env" >> "$sudoers"
done

install -m 600 -o opengym-deploy -g opengym-deploy "$keys" ~opengym-deploy/.ssh/authorized_keys
visudo -cqf "$sudoers"
install -m 440 -o root -g root "$sudoers" /etc/sudoers.d/opengym-release
find /srv/opengym -maxdepth 2 -printf '%M %u:%g %p\n' | sort -k3
tailscale serve status

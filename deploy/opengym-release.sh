#!/usr/bin/env bash
# opengym-release: deploys, rolls back and reports openGym releases on Boop Beep. Installed as
# /usr/local/bin/opengym-release by deploy/host-setup.sh and run as root (docs/BRINDLE_DEPLOY.md).
#
#   opengym-release deploy   <env>  < plan.json   go to a new release (plan: scripts/deploy/coolify.mjs plan)
#   opengym-release rollback <env> [release-id]   back to the release before the live one, or the one named
#   opengym-release status   <env>                what is live
#   opengym-release history  <env>                the releases kept on this host, newest first
#
# Every line it prints is one JSON object; the last is the result, with "ok": true or false.
# One operation per environment at a time: a second one waits for the lock.
#
# The model is the one Kamal and Cloudflare Workers use: every release is kept (the last 10),
# and a rollback makes an earlier one live again without building or pulling anything. The
# difference is the swap. openGym's API keeps its data in memory and in files, so two copies may
# never run at once: the old containers stop, the kept ones start (about 5 s, docs).
#
# A deploy goes through Coolify, which owns the service: the plan's compose is uploaded, Coolify
# starts it, and the tool waits for Coolify's own record of that run to finish (Coolify neither
# queues compose deploys nor reports their end over its API; two overlapping runs broke staging
# once). Then the new release must be healthy and serve its commit and settings, or the release
# before it is restored. What Coolify generated is kept as the release's snapshot. A rollback
# starts a snapshot with docker compose directly and then records it in Coolify.
#
# Over SSH (the deploy jobs), each key is bound to one environment by its forced command,
# `sudo -n /usr/local/bin/opengym-release --ssh <env>`; the request comes in SSH_ORIGINAL_COMMAND.
set -euo pipefail

ROOT=/srv/opengym
COOLIFY_API=http://127.0.0.1:8000/api/v1
TOKEN_FILE=/etc/opengym/coolify-token
KEEP=10

say() { local e=$1; shift; jq -cn --arg event "$e" "$@" '{event: $event} + $ARGS.named'; }
finish() { local ok=$1; shift; jq -cn --argjson ok "$ok" "$@" '{result: true, ok: $ok} + $ARGS.named'; [ "$ok" = true ]; exit $?; }
die() { finish false --arg error "$1"; }
elapsed() { awk -v a="$1" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }'; }

valid_env() { case "$1" in staging|production) ;; *) die "unknown environment: $1" ;; esac; }

if [ "${1:-}" = --ssh ]; then
  bound=${2:-}; valid_env "$bound"
  read -r -a req <<< "${SSH_ORIGINAL_COMMAND:-}"
  case "${req[0]:-}" in deploy|rollback|status|history) ;; *) die "allowed: deploy|rollback|status|history <env> [release-id]" ;; esac
  [ "${req[1]:-}" = "$bound" ] || die "this key may only act on $bound"
  [ "${#req[@]}" -le 3 ] || die "too many arguments"
  set -- "${req[@]}"
fi

[ "$(id -u)" = 0 ] || die "run as root"
cmd=${1:-}; env=${2:-}
case "$cmd" in deploy|rollback|status|history) ;; *) die "usage: opengym-release deploy|rollback|status|history <env> [release-id]" ;; esac
valid_env "$env"

dir=$ROOT/$env
releases=$dir/releases
uuid=$(cat "$dir/service-uuid" 2>/dev/null) || die "$dir/service-uuid is missing (deploy/host-setup.sh)"
[[ $uuid =~ ^[a-z0-9]+$ ]] || die "bad service uuid in $dir/service-uuid"
svc=/data/coolify/services/$uuid
install -d -m 700 "$releases"

current_id() { cat "$dir/current" 2>/dev/null || true; }
history_ids() { find "$releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r; }

if [ "$cmd" = history ]; then
  cur=$(current_id)
  while read -r id; do
    [ -n "$id" ] || continue
    jq -c --arg id "$id" --arg cur "$cur" '{id: $id, live: ($id == $cur), sha, api, web}' "$releases/$id/release.json"
  done <<< "$(history_ids)"
  finish true --arg env "$env"
fi

# What the loopback port serves right now.
probe() {
  local port=$1 rel health config
  rel=$(curl -fsS -m 3 "http://127.0.0.1:$port/release.json?t=$(date +%s%N)" 2>/dev/null) || rel='{}'
  health=$(curl -fsS -m 3 "http://127.0.0.1:$port/api/health" 2>/dev/null) || health='{}'
  config=$(curl -fsS -m 3 "http://127.0.0.1:$port/api/config" 2>/dev/null) || config='{}'
  jq -cn --argjson rel "$rel" --argjson health "$health" --argjson config "$config" \
    '{revision: ($rel.revision // null), healthy: ($health.writable == true), users: ($health.users // null),
      invite_only: $config.invite_only, allow_guest: $config.allow_guest}' 2>/dev/null || echo '{}'
}

if [ "$cmd" = status ]; then
  cur=$(current_id)
  [ -n "$cur" ] || finish true --arg env "$env" --arg note "no release recorded on this host yet"
  finish true --arg env "$env" --arg release "$cur" --argjson recorded "$(cat "$releases/$cur/release.json")" \
    --argjson live "$(probe "$(jq -r .local_port "$releases/$cur/plan.json")")"
fi

exec 9> "$dir/.lock"
if ! flock -n 9; then
  say waiting-for-lock --arg env "$env"
  flock -w 900 9 || die "another operation on $env held the lock for 15 minutes"
fi

coolify() { # method route [json-body]
  local auth; auth="Authorization: Bearer $(cat "$TOKEN_FILE")"
  curl -fsS -m 30 -X "$1" -H "$auth" -H 'Accept: application/json' \
    ${3:+-H 'Content-Type: application/json' --data-binary "$3"} "$COOLIFY_API/$2"
}
# Coolify's own record of its runs for this service (activity_log): id and status of the latest.
coolify_run() {
  docker exec coolify-db psql -U coolify -d coolify -AtF ' ' -c \
    "select id, properties->>'status' from activity_log where properties->>'type_uuid' = '$uuid' order by id desc limit 1"
}

# Until api and web are healthy and the port serves `sha` with the plan's settings.
wait_live() {
  local plan=$1 sha=$2 timeout=$3 port want deadline state c health live
  port=$(jq -r .local_port "$plan"); want=$(jq -c .expect "$plan")
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    state=ok
    for c in api web; do
      health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c-$uuid" 2>/dev/null) || health=missing
      [ "$health" = healthy ] || { state="$c $health"; break; }
    done
    if [ "$state" = ok ]; then
      live=$(probe "$port")
      jq -e --arg sha "$sha" --argjson want "$want" \
        '.revision == $sha and .healthy and .invite_only == $want.invite_only and .allow_guest == $want.allow_guest' \
        <<< "$live" >/dev/null && return 0
      state="serving $live"
    fi
    [ "$(date +%s)" -lt "$deadline" ] || { say not-live --arg last "$state"; return 1; }
    sleep 0.25
  done
}

# Starts a kept snapshot directly, then records it in Coolify without letting Coolify redeploy.
restore() {
  local id=$1 plan=$releases/$1/plan.json
  install -m 600 "$releases/$id/docker-compose.yml" "$svc/docker-compose.yml"
  install -m 600 "$releases/$id/env" "$svc/.env"
  (cd "$svc" && docker compose -p "$uuid" up -d --remove-orphans >/dev/null 2>&1) || { say compose-failed --arg release "$id"; return 1; }
  wait_live "$plan" "$(jq -r .sha "$releases/$id/release.json")" 120 || return 1
  echo "$id" > "$dir/current"
  coolify PATCH "services/$uuid" "$(jq -c '{docker_compose_raw, urls}' "$plan")" >/dev/null \
    && coolify PATCH "services/$uuid/envs/bulk" "$(jq -c '{data: .service_env}' "$plan")" >/dev/null \
    || say coolify-not-updated --arg release "$id" --arg note "running fine; Coolify still shows the release it deployed last"
}

if [ "$cmd" = rollback ]; then
  t0=$(date +%s.%N)
  cur=$(current_id)
  target=${3:-}
  if [ -z "$target" ]; then
    [ -n "$cur" ] && [ -f "$releases/$cur/previous" ] || die "nothing recorded before $cur (opengym-release history $env)"
    target=$(cat "$releases/$cur/previous")
  fi
  { [[ $target =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$ ]] && [ -d "$releases/$target" ]; } \
    || die "no kept release $target (opengym-release history $env)"
  [ "$target" != "$cur" ] || die "$target is already live"
  say rolling-back --arg env "$env" --arg from "$cur" --arg to "$target"
  restore "$target" || die "rollback to $target did not come up (opengym-release status $env)"
  finish true --arg env "$env" --arg release "$target" --arg from "$cur" --argjson seconds "$(elapsed "$t0")"
fi

# --- deploy ------------------------------------------------------------------------------------
t0=$(date +%s.%N)
plan=$(mktemp); trap 'rm -f "$plan"' EXIT
head -c 1000000 > "$plan"
jq -e --arg env "$env" '
  .env == $env and (.release.sha | test("^[0-9a-f]{40}$"))
  and (.release.api | test("^ghcr\\.io/brindlehq/opengym-api@sha256:[0-9a-f]{64}$"))
  and (.release.web | test("^ghcr\\.io/brindlehq/opengym-web@sha256:[0-9a-f]{64}$"))
  and (.local_port | type == "number") and (.docker_compose_raw | type == "string")
  and (.expect.invite_only | type == "boolean") and (.expect.allow_guest | type == "boolean")' "$plan" >/dev/null 2>&1 \
  || die "plan rejected: not a valid plan for $env"
sha=$(jq -r .release.sha "$plan")
cur=$(current_id)
same() { cmp -s <(jq -S '{env, docker_compose_raw, urls, service_env, local_port, expect}' "$1") \
               <(jq -S '{env, docker_compose_raw, urls, service_env, local_port, expect}' "$2"); }
if [ -n "$cur" ] && same "$plan" "$releases/$cur/plan.json" && wait_live "$plan" "$sha" 15; then
  finish true --arg env "$env" --arg release "$cur" --arg note "already live"
fi

id=$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:7}
say deploying --arg env "$env" --arg release "$id" --arg sha "$sha" --arg previous "$cur"
read -r last_run last_status <<< "$(coolify_run)" || true
case "${last_status:-}" in queued|in_progress) die "Coolify is already running something for $env (activity $last_run); try again" ;; esac
coolify PATCH "services/$uuid" "$(jq -c '{docker_compose_raw, urls}' "$plan")" >/dev/null || die "Coolify refused the compose"
coolify PATCH "services/$uuid/envs/bulk" "$(jq -c '{data: .service_env}' "$plan")" >/dev/null || die "Coolify refused the variables"
coolify POST "deploy?uuid=$uuid&force=false" >/dev/null || die "Coolify refused the deploy"

outcome=timeout
for _ in $(seq 1 600); do
  read -r run status <<< "$(coolify_run)" || true
  if [ "${run:-0}" -gt "${last_run:-0}" ]; then
    case "$status" in finished) outcome=finished; break ;; error|failed) outcome=error; break ;; esac
  fi
  sleep 0.5
done
say coolify-run --arg outcome "$outcome" --arg activity "${run:-}"

if [ "$outcome" = finished ] && wait_live "$plan" "$sha" 120; then
  install -d -m 700 "$releases/$id"
  install -m 600 "$plan" "$releases/$id/plan.json"
  jq '.release' "$plan" > "$releases/$id/release.json"
  install -m 600 "$svc/docker-compose.yml" "$releases/$id/docker-compose.yml"
  install -m 600 "$svc/.env" "$releases/$id/env"
  if [ -n "$cur" ]; then echo "$cur" > "$releases/$id/previous"; fi
  echo "$id" > "$dir/current"
  history_ids | tail -n +$((KEEP + 1)) | while read -r old; do [ -z "$old" ] || rm -rf "${releases:?}/$old"; done
  finish true --arg env "$env" --arg release "$id" --arg previous "$cur" --argjson seconds "$(elapsed "$t0")"
fi

say deploy-failed --arg env "$env" --arg release "$id" --arg coolify "$outcome"
[ -n "$cur" ] || die "$id did not come up, and there is no earlier release on this host to go back to"
restore "$cur" || die "$id did not come up, and restoring $cur failed too (opengym-release status $env)"
finish false --arg env "$env" --arg error "$id did not come up; $cur is live again" --arg release "$cur" --argjson seconds "$(elapsed "$t0")"

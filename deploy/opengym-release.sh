#!/usr/bin/env bash
# opengym-release: deploys, rolls back and reports openGym releases on Boop Beep. Installed as
# /usr/local/bin/opengym-release by deploy/host-setup.sh and run as root (docs/BRINDLE_DEPLOY.md).
#
#   opengym-release deploy   <env> [--bootstrap] < release.json   go to a new release
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
# A deploy takes only the release's identity (commit and two image digests). The compose is
# rendered here, from the template and settings host-setup.sh installed from a reviewed checkout
# (/usr/local/lib/opengym): a deploy key can choose which release runs, never what it runs as.
# It goes through Coolify, which owns the service: the compose is uploaded, Coolify starts it,
# and the tool waits for Coolify's own record of that run to finish (Coolify neither
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
LIB=/usr/local/lib/opengym
# The same node image the app is built on, by digest: root never runs a node from a user's home.
NODE_IMAGE=node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
# Releases kept per environment. OPENGYM_KEEP only reaches it when root runs the tool directly;
# over SSH, sudo passes nothing but the request.
KEEP=${OPENGYM_KEEP:-10}

say() { local e=$1; shift; jq -cn --arg event "$e" "$@" '{event: $event} + $ARGS.named'; }
finish() { local ok=$1; shift; jq -cn --argjson ok "$ok" "$@" '{result: true, ok: $ok} + $ARGS.named'; [ "$ok" = true ]; exit $?; }
die() { finish false --arg error "$1"; }
elapsed() { awk -v a="$1" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }'; }

[[ $KEEP =~ ^[1-9][0-9]?$ ]] || { echo '{"result":true,"ok":false,"error":"OPENGYM_KEEP must be 1-99"}'; exit 1; }
valid_env() { case "$1" in staging|production) ;; *) die "unknown environment: $1" ;; esac; }

if [ "${1:-}" = --ssh ]; then
  bound=${2:-}; valid_env "$bound"
  read -r -a req <<< "${SSH_ORIGINAL_COMMAND:-}"
  case "${req[0]:-}" in deploy|rollback|status|history) ;; *) die "allowed: deploy|rollback|status|history <env> [release-id|--bootstrap]" ;; esac
  [ "${req[1]:-}" = "$bound" ] || die "this key may only act on $bound"
  [ "${#req[@]}" -le 3 ] || die "too many arguments"
  if [ "${#req[@]}" = 3 ]; then
    case "${req[0]}" in deploy) [ "${req[2]}" = --bootstrap ] || die "deploy takes only --bootstrap" ;; rollback) ;; *) die "too many arguments" ;; esac
  fi
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
done_status() { case "${1:-}" in ''|finished|error|failed|cancelled) return 0 ;; *) return 1 ;; esac; }
# Waits until Coolify runs nothing for this service: one started from its UI or API does not
# take this lock, and two runs at once on one compose project break it.
coolify_idle() {
  local run status i
  for i in $(seq 1 1200); do
    read -r run status <<< "$(coolify_run)" || true
    done_status "${status:-}" && return 0
    if [ "$i" = 1 ]; then say waiting-for-coolify --arg activity "${run:-}" --arg status "${status:-}"; fi
    sleep 0.5
  done
  return 1
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

# Starts a kept snapshot directly. Coolify is told first, so a Coolify run that slips in anyway
# (started from its UI, or queued and not yet recorded, which no check here can see) deploys the
# same release instead of undoing this one; then the result is checked again once Coolify is idle.
restore() {
  local id=$1 plan=$releases/$1/plan.json sha
  sha=$(jq -r .sha "$releases/$id/release.json")
  coolify PATCH "services/$uuid" "$(jq -c '{docker_compose_raw, urls}' "$plan")" >/dev/null \
    && coolify PATCH "services/$uuid/envs/bulk" "$(jq -c '{data: .service_env}' "$plan")" >/dev/null \
    || say coolify-not-updated --arg release "$id" --arg note "a later Coolify run would start the release it has on record"
  install -m 600 "$releases/$id/docker-compose.yml" "$svc/docker-compose.yml"
  install -m 600 "$releases/$id/env" "$svc/.env"
  if ! (cd "$svc" && docker compose -p "$uuid" up -d --remove-orphans >/dev/null 2>&1); then
    # Most likely a Coolify run on the same project at the same moment. Once it is done, it has
    # either started this release (it was told first) or left something to repair: start it again.
    say compose-busy --arg release "$id"
    coolify_idle || return 1
    if ! wait_live "$plan" "$sha" 20; then
      install -m 600 "$releases/$id/docker-compose.yml" "$svc/docker-compose.yml"
      install -m 600 "$releases/$id/env" "$svc/.env"
      (cd "$svc" && docker compose -p "$uuid" up -d --remove-orphans >/dev/null 2>&1) || { say compose-failed --arg release "$id"; return 1; }
    fi
  fi
  wait_live "$plan" "$sha" 120 || return 1
  coolify_idle && wait_live "$plan" "$sha" 120 || return 1
  echo "$id" > "$dir/current"
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
  # The record alone is not enough: if something else ended up running, the same command repairs it.
  if [ "$target" = "$cur" ] && wait_live "$releases/$target/plan.json" "$(jq -r .sha "$releases/$target/release.json")" 3; then
    die "$target is already live"
  fi
  coolify_idle || die "Coolify has been running something on $env for 10 minutes; not touching it"
  say rolling-back --arg env "$env" --arg from "$cur" --arg to "$target"
  restore "$target" || die "rollback to $target did not come up (opengym-release status $env)"
  finish true --arg env "$env" --arg release "$target" --arg from "$cur" --argjson seconds "$(elapsed "$t0")"
fi

# --- deploy -------------------------------------------------------------------------------------
t0=$(date +%s.%N)
bootstrap=${3:-}
case "$bootstrap" in ''|--bootstrap) ;; *) die "deploy takes only --bootstrap" ;; esac
release=$(mktemp); plan=$(mktemp); trap 'rm -f "$release" "$plan"' EXIT
head -c 10000 | jq -ce '
  select((.sha | test("^[0-9a-f]{40}$"))
    and (.api | test("^ghcr\\.io/brindlehq/opengym-api@sha256:[0-9a-f]{64}$"))
    and (.web | test("^ghcr\\.io/brindlehq/opengym-web@sha256:[0-9a-f]{64}$"))
    and ((.run_id // "0") | tostring | test("^[0-9]{1,20}$")))
  | {sha, api, web} + (if .run_id then {run_id: (.run_id | tostring)} else {} end)' > "$release" 2>/dev/null \
  || die "release rejected: send {sha, api, web} for BrindleHQ images by digest"
docker run --rm -i --network none --read-only -v "$LIB:/opt/opengym:ro" "$NODE_IMAGE" \
  node /opt/opengym/scripts/deploy/coolify.mjs plan "$env" /dev/stdin ${bootstrap:+"$bootstrap"} < "$release" > "$plan" 2>/dev/null \
  || die "could not render $env from $LIB (deploy/host-setup.sh installs it)"
sha=$(jq -r .release.sha "$plan")
cur=$(current_id)
same() { cmp -s <(jq -S '{env, docker_compose_raw, urls, service_env, local_port, expect}' "$1") \
               <(jq -S '{env, docker_compose_raw, urls, service_env, local_port, expect}' "$2"); }
if [ -n "$cur" ] && same "$plan" "$releases/$cur/plan.json" && wait_live "$plan" "$sha" 15; then
  finish true --arg env "$env" --arg release "$cur" --arg note "already live" --arg url "$(jq -r .url "$plan")"
fi

id=$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:7}
say deploying --arg env "$env" --arg release "$id" --arg sha "$sha" --arg previous "$cur"
coolify_idle || die "Coolify has been running something on $env for 10 minutes; not deploying over it"
read -r last_run _ <<< "$(coolify_run)" || true
coolify PATCH "services/$uuid" "$(jq -c '{docker_compose_raw, urls}' "$plan")" >/dev/null || die "Coolify refused the compose"
coolify PATCH "services/$uuid/envs/bulk" "$(jq -c '{data: .service_env}' "$plan")" >/dev/null || die "Coolify refused the variables"
coolify POST "deploy?uuid=$uuid&force=false" >/dev/null || die "Coolify refused the deploy"

outcome=timeout
for _ in $(seq 1 600); do
  read -r run status <<< "$(coolify_run)" || true
  if [ "${run:-0}" -gt "${last_run:-0}" ]; then
    case "$status" in finished) outcome=finished; break ;; error|failed|cancelled) outcome=error; break ;; esac
  fi
  sleep 0.5
done
say coolify-run --arg outcome "$outcome" --arg activity "${run:-}"

if [ "$outcome" = finished ] && wait_live "$plan" "$sha" 120 && coolify_idle && wait_live "$plan" "$sha" 60; then
  install -d -m 700 "$releases/$id"
  install -m 600 "$plan" "$releases/$id/plan.json"
  jq '.release' "$plan" > "$releases/$id/release.json"
  install -m 600 "$svc/docker-compose.yml" "$releases/$id/docker-compose.yml"
  install -m 600 "$svc/.env" "$releases/$id/env"
  if [ -n "$cur" ]; then echo "$cur" > "$releases/$id/previous"; fi
  echo "$id" > "$dir/current"
  # Never the live release or the one a plain rollback goes back to.
  while read -r old; do
    if [ -n "$old" ] && [ "$old" != "$id" ] && [ "$old" != "$cur" ]; then rm -rf "${releases:?}/$old"; fi
  done <<< "$(history_ids | tail -n +$((KEEP + 1)))"
  finish true --arg env "$env" --arg release "$id" --arg previous "$cur" --argjson seconds "$(elapsed "$t0")" \
    --arg url "$(jq -r .url "$plan")"
fi

say deploy-failed --arg env "$env" --arg release "$id" --arg coolify "$outcome"
[ -n "$cur" ] || die "$id did not come up, and there is no earlier release on this host to go back to"
# A run that is still going would undo the restore when it ends.
coolify_idle || die "$id did not come up and Coolify is still running it after 10 minutes; not restoring over it (opengym-release status $env)"
restore "$cur" || die "$id did not come up, and restoring $cur failed too (opengym-release status $env)"
finish false --arg env "$env" --arg error "$id did not come up; $cur is live again" --arg release "$cur" --argjson seconds "$(elapsed "$t0")"

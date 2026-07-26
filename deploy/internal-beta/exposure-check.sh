#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'internal beta Admin exposure check failed: %s\n' "$1" >&2
  exit 1
}

port=${AERA_ADMIN_PRIVATE_PORT:-19090}
[[ $port =~ ^[1-9][0-9]{0,4}$ && $port -le 65535 ]] ||
  fail 'AERA_ADMIN_PRIVATE_PORT is invalid'
command -v ss >/dev/null 2>&1 || fail 'ss is required'
command -v docker >/dev/null 2>&1 || fail 'docker is required'

listeners=$(ss -H -lnt "sport = :$port")
[[ -n $listeners ]] || fail "private Admin port $port is not listening"
while IFS= read -r listener; do
  [[ -n $listener ]] || continue
  local_address=$(awk '{print $4}' <<<"$listener")
  case "$local_address" in
    127.0.0.1:"$port" | "[::1]":"$port") ;;
    *) fail "Admin port $port is not loopback-only" ;;
  esac
done <<<"$listeners"

while IFS=$'\t' read -r container ports; do
  [[ -n ${container:-} ]] || continue
  if [[ $ports == *"0.0.0.0:"* || $ports == *":::"* || $ports == *"[::]:"* ]]; then
    fail "container $container publishes a port on every interface"
  fi
  if [[ $container == aera-admin-internal-beta-* ]] &&
    [[ $ports == *":3000->"* || $ports == *":3000/"* ]]; then
    fail "Payload is published outside the private Docker network"
  fi
done < <(docker ps --format '{{.Names}}\t{{.Ports}}')

if [[ -n ${AERA_INTERNAL_BETA_PUBLIC_ORIGIN:-} ]]; then
  [[ $AERA_INTERNAL_BETA_PUBLIC_ORIGIN =~ ^https://([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] ||
    fail 'AERA_INTERNAL_BETA_PUBLIC_ORIGIN must be an exact HTTPS IPv4 origin'
  public_code=$(curl \
    --silent \
    --show-error \
    --output /dev/null \
    --write-out '%{http_code}' \
    --proto '=https' \
    --tlsv1.2 \
    --connect-timeout 10 \
    --max-time 20 \
    "$AERA_INTERNAL_BETA_PUBLIC_ORIGIN/admin/" || true)
  [[ $public_code == 404 ]] ||
    fail "public Cloud origin exposed or intercepted /admin/ (HTTP $public_code)"
fi

printf 'internal beta Admin exposure check passed\n'

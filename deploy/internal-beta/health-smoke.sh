#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'internal beta Admin health smoke failed: %s\n' "$1" >&2
  exit 1
}

port=${AERA_ADMIN_PRIVATE_PORT:-19090}
[[ $port =~ ^[1-9][0-9]{0,4}$ && $port -le 65535 ]] ||
  fail 'AERA_ADMIN_PRIVATE_PORT is invalid'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v jq >/dev/null 2>&1 || fail 'jq is required'

health_checks_enabled=${AERA_ADMIN_HEALTH_CHECKS_ENABLED:-false}
case "$health_checks_enabled" in
  true | false) ;;
  *) fail 'AERA_ADMIN_HEALTH_CHECKS_ENABLED must be true or false' ;;
esac

origin="http://127.0.0.1:$port"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/aera-admin-health.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
curl_args=(
  --silent
  --show-error
  --connect-timeout 5
  --max-time 20
  --retry 15
  --retry-delay 2
  --retry-max-time 45
  --retry-all-errors
  --retry-connrefused
)

curl "${curl_args[@]}" --fail "$origin/health/live" >"$tmp/live.json"
curl "${curl_args[@]}" --fail "$origin/health/ready" >"$tmp/ready.json"
jq -e '.service == "aera-admin-gateway" and .status == "ok"' \
  "$tmp/live.json" >/dev/null ||
  fail 'gateway liveness response is invalid'
jq -e --arg enabled "$health_checks_enabled" '
  .service == "aera-admin" and
  .status == "ok" and
  .mutationsEnabled == false and
  .healthChecksEnabled == ($enabled == "true")
' "$tmp/ready.json" >/dev/null ||
  fail 'Admin readiness or default mutation policy is invalid'

curl "${curl_args[@]}" --fail "$origin/admin/" >"$tmp/admin.html"
grep -Eq '<title>[^<]*(Aera|管理)' "$tmp/admin.html" ||
  fail 'Soybean Admin index was not served'

api_status=$(curl "${curl_args[@]}" \
  --output "$tmp/me.json" \
  --write-out '%{http_code}' \
  "$origin/api/admins/me")
[[ $api_status == 200 || $api_status == 401 ]] ||
  fail "Payload same-origin API returned HTTP $api_status"

mutation_status=$(curl "${curl_args[@]}" \
  --output "$tmp/mutation.json" \
  --write-out '%{http_code}' \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{}' \
  "$origin/api/platform/v1/createUser")
[[ $mutation_status == 503 ]] ||
  fail 'business mutation was not disabled by default'
jq -e '.error.code == "MUTATIONS_DISABLED"' "$tmp/mutation.json" >/dev/null ||
  fail 'disabled mutation response is invalid'

health_status=$(curl "${curl_args[@]}" \
  --output "$tmp/health-command.json" \
  --write-out '%{http_code}' \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{}' \
  "$origin/api/platform/v1/runtime/commands")
if [[ $health_checks_enabled == true ]]; then
  [[ $health_status == 401 || $health_status == 403 ]] ||
    fail 'health-check mutation allowlist did not reach Payload auth'
else
  [[ $health_status == 503 ]] ||
    fail 'health-check mutation was not disabled by default'
  jq -e '.error.code == "MUTATIONS_DISABLED"' "$tmp/health-command.json" >/dev/null ||
    fail 'disabled health-check response is invalid'
fi

printf 'internal beta Admin health smoke passed (private, mutations disabled)\n'

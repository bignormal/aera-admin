#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
runner="$root/scripts/run-e2e.sh"

test ! -e "$root/e2e/cloud-stub/main.go"
grep -q 'AERA_ADMIN_E2E_CLOUD_REPO' "$runner"
grep -q 'github.com/bignormal/aera-cloud' "$runner"
grep -q 'cmd/aera-cloud-e2e' "$runner"
grep -q 'AERA_ADMIN_E2E_CLOUD_FIXTURE_FILE' "$runner"
grep -q 'AERA_ADMIN_E2E_CLOUD_VERIFY_BINARY' "$runner"
grep -q 'AERA_ADMIN_POSTGRES_BIND=127.0.0.1:' "$runner"
grep -q 'AERA_CLOUD_POSTGRES_BIND=127.0.0.1:' "$runner"
grep -q 'docker compose -p' "$runner"
grep -q 'docker compose.* port postgres 5432' "$runner"
grep -q 'docker compose.* port redis 6379' "$runner"
grep -q 'keyUsage=critical,keyCertSign,cRLSign' "$runner"

if grep -q 'cloud-stub' "$runner" "$root/Makefile"; then
  echo 'real Cloud E2E still references the Stub' >&2
  exit 1
fi

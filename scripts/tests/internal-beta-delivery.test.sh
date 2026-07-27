#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

fail() {
  printf 'internal beta Admin delivery test failed: %s\n' "$1" >&2
  exit 1
}

require_file() {
  [[ -f $1 ]] || fail "missing $1"
}

require_text() {
  grep -Eq "$2" "$1" || fail "$1 does not match $2"
}

for file in \
  Dockerfile \
  next.config.ts \
  deploy/compose.internal-beta.yaml \
  deploy/internal-beta/gateway.mjs \
  deploy/internal-beta/deploy.sh \
  deploy/internal-beta/cloud-smoke.sh \
  deploy/internal-beta/health-smoke.sh \
  deploy/internal-beta/exposure-check.sh \
  scripts/release/build-manifest.sh \
  scripts/release/build-provenance.sh \
  scripts/release/verify-manifest.sh \
  .github/workflows/candidate.yml; do
  require_file "$file"
done

require_text next.config.ts "output: 'standalone'"
require_text package.json '"packageManager": "pnpm@10\.34\.5"'
require_text Dockerfile '/app/admin-web/dist ./admin-web-dist'
require_text Dockerfile 'USER nextjs'
require_text deploy/compose.internal-beta.yaml 'AGENTERA_ADMIN_IMAGE_DIGEST'
require_text deploy/compose.internal-beta.yaml '127\.0\.0\.1:'
require_text deploy/compose.internal-beta.yaml 'AERA_ADMIN_MUTATIONS_ENABLED:-false'
require_text deploy/compose.internal-beta.yaml 'read_only: true'
require_text deploy/compose.internal-beta.yaml 'AERA_ADMIN_PKI_DIR'
require_text deploy/compose.internal-beta.yaml 'aera-cloud-admin-private'
require_text deploy/internal-beta/gateway.mjs 'MUTATIONS_DISABLED'
require_text deploy/internal-beta/deploy.sh 'verify-manifest\.sh'
require_text deploy/internal-beta/deploy.sh 'cloud-smoke\.sh'
require_text deploy/internal-beta/deploy.sh 'candidate digest is already current'
require_text deploy/internal-beta/cloud-smoke.sh 'baseURL\.port !== "8443"'
require_text deploy/internal-beta/exposure-check.sh 'loopback-only'
require_text .github/workflows/candidate.yml 'inputs\.source_sha'
require_text .github/workflows/candidate.yml 'inputs\.ci_run_id'
require_text .github/workflows/candidate.yml 'inputs\.cloud_source_sha'
require_text .github/workflows/candidate.yml 'docker buildx build'
require_text .github/workflows/candidate.yml 'cosign sign --yes'
require_text .github/workflows/candidate.yml 'cosign attest --yes'
require_text .github/workflows/candidate.yml 'cosign sign-blob --yes'
require_text .github/workflows/candidate.yml 'AERA_RELEASE_CLOUD_SCHEMA_MAX: "20"'
require_text scripts/release/verify-manifest.sh 'cosign verify-attestation'
require_text scripts/release/verify-manifest.sh 'cosign verify-blob'

compose_config=$(AERA_ADMIN_ENV_FILE=/dev/null \
  AERA_ADMIN_PKI_DIR=/tmp \
  AGENTERA_ADMIN_IMAGE_DIGEST=ghcr.io/bignormal/aera-admin@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  docker compose -f deploy/compose.internal-beta.yaml config --format json)

jq -e '
  (.services.gateway.networks | keys | sort) ==
    ["aera-admin-loopback-publish", "aera-admin-private"] and
  (.services.payload.networks | has("aera-admin-loopback-publish") | not) and
  .networks["aera-admin-private"].internal == true and
  (.networks["aera-admin-loopback-publish"].internal // false) == false and
  (.services.gateway.ports | length) == 1 and
  (
    .services.gateway.ports[0] |
    .host_ip == "127.0.0.1" and
    .published == "19090" and
    .target == 8080
  )
' <<<"$compose_config" >/dev/null ||
  fail 'gateway loopback publication topology is invalid'

node --test scripts/tests/gateway.test.mjs

tmp=$(mktemp -d "${TMPDIR:-/tmp}/aera-admin-internal-beta.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/evidence" "$tmp/pki" "$tmp/state"
command_log="$tmp/commands.log"
export AERA_ADMIN_DELIVERY_TEST_LOG="$command_log"

for pki_file in ca.pem client.pem client-key.pem service-key.pem; do
  : >"$tmp/pki/$pki_file"
done
printf 'services: {}\n' >"$tmp/compose.yaml"
printf 'fixture only\n' >"$tmp/admin.env"

digest() {
  local character=$1
  printf 'sha256:'
  for _ in {1..64}; do
    printf '%s' "$character"
  done
}

manifest() {
  local path=$1
  local sha=$2
  local cloud_sha=$3
  local image_digest=$4
  jq -cnS \
    --arg sha "$sha" \
    --arg cloud "$cloud_sha" \
    --arg digest "$image_digest" \
    --arg reference "ghcr.io/bignormal/aera-admin@$image_digest" '
      {
        schemaVersion: 1,
        repository: "bignormal/aera-admin",
        commitSha: $sha,
        image: {reference: $reference, digest: $digest},
        compatibility: {
          cloudCommitSha: $cloud,
          cloudInternalApiVersion: "v1",
          cloudSchemaMinimum: 17,
          cloudSchemaMaximum: 20
        },
        mutationsEnabledByDefault: false
      }
    ' >"$path"
  printf '\n' >>"$path"
}

cat >"$tmp/bin/verify" <<'SH'
#!/bin/sh
set -eu
manifest=$1
test "$(jq -r '.commitSha' "$manifest")" = "$AERA_RELEASE_EXPECTED_SHA"
test "$(jq -r '.compatibility.cloudCommitSha' "$manifest")" = \
  "$AERA_RELEASE_EXPECTED_CLOUD_SHA"
printf 'verify %s\n' "$(jq -r '.image.digest' "$manifest")" \
  >>"$AERA_ADMIN_DELIVERY_TEST_LOG"
SH

cat >"$tmp/bin/docker" <<'SH'
#!/bin/sh
set -eu
printf 'docker image=%s %s\n' "${AGENTERA_ADMIN_IMAGE_DIGEST:-none}" "$*" \
  >>"$AERA_ADMIN_DELIVERY_TEST_LOG"
if test "${1:-}" = compose; then
  case " $* " in
    *" up "*)
      printf '%s\n' "$AGENTERA_ADMIN_IMAGE_DIGEST" \
        >"$AERA_INTERNAL_BETA_ADMIN_STATE_DIR/test-running-image"
      ;;
  esac
fi
SH

cat >"$tmp/bin/health" <<'SH'
#!/bin/sh
set -eu
running=$(cat "$AERA_INTERNAL_BETA_ADMIN_STATE_DIR/test-running-image")
printf 'health %s\n' "$running" >>"$AERA_ADMIN_DELIVERY_TEST_LOG"
test "${AERA_ADMIN_DELIVERY_FAIL_IMAGE:-}" != "$running"
SH

cat >"$tmp/bin/cloud-health" <<'SH'
#!/bin/sh
set -eu
test -n "${AERA_ADMIN_PAYLOAD_CONTAINER:-}"
printf 'cloud-health\n' >>"$AERA_ADMIN_DELIVERY_TEST_LOG"
SH

cat >"$tmp/bin/exposure" <<'SH'
#!/bin/sh
set -eu
printf 'exposure\n' >>"$AERA_ADMIN_DELIVERY_TEST_LOG"
SH

cat >"$tmp/bin/ss" <<'SH'
#!/bin/sh
set -eu
printf 'LISTEN 0 128 %s:%s 0.0.0.0:*\n' \
  "${AERA_ADMIN_TEST_LISTENER:-127.0.0.1}" \
  "${AERA_ADMIN_PRIVATE_PORT:-19090}"
SH

cat >"$tmp/bin/curl" <<'SH'
#!/bin/sh
set -eu
printf '404'
SH

chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH"
export AERA_ADMIN_ENV_FILE="$tmp/admin.env"
export AERA_ADMIN_PKI_DIR="$tmp/pki"
export AERA_INTERNAL_BETA_ADMIN_STATE_DIR="$tmp/state"
export AERA_INTERNAL_BETA_ADMIN_COMPOSE_FILE="$tmp/compose.yaml"
export AERA_INTERNAL_BETA_ADMIN_COMPOSE_PROJECT=aera-admin-delivery-test
export AERA_INTERNAL_BETA_ADMIN_VERIFY_COMMAND="$tmp/bin/verify"
export AERA_INTERNAL_BETA_ADMIN_HEALTH_COMMAND="$tmp/bin/health"
export AERA_INTERNAL_BETA_ADMIN_CLOUD_HEALTH_COMMAND="$tmp/bin/cloud-health"
export AERA_INTERNAL_BETA_ADMIN_EXPOSURE_COMMAND="$tmp/bin/exposure"

sha_a=$(printf 'a%.0s' {1..40})
sha_b=$(printf 'b%.0s' {1..40})
cloud_sha=$(printf 'c%.0s' {1..40})
digest_a=$(digest a)
digest_b=$(digest b)
reference_a="ghcr.io/bignormal/aera-admin@$digest_a"
reference_b="ghcr.io/bignormal/aera-admin@$digest_b"
manifest "$tmp/evidence/a.json" "$sha_a" "$cloud_sha" "$digest_a"
manifest "$tmp/evidence/b.json" "$sha_b" "$cloud_sha" "$digest_b"

export AERA_INTERNAL_BETA_ADMIN_EXPECTED_SHA="$sha_a"
export AERA_INTERNAL_BETA_ADMIN_EXPECTED_CLOUD_SHA="$cloud_sha"
deploy/internal-beta/deploy.sh deploy "$tmp/evidence/a.json"
jq -e --arg digest "$digest_a" '
  .environment == "internal_beta" and
  .privateAccess == "ssh_loopback" and
  .mutationsEnabled == false and
  .current.imageDigest == $digest and
  .previous == null
' "$tmp/state/deployment-state.json" >/dev/null

export AERA_INTERNAL_BETA_ADMIN_EXPECTED_SHA="$sha_b"
export AERA_ADMIN_DELIVERY_FAIL_IMAGE="$reference_b"
if deploy/internal-beta/deploy.sh deploy "$tmp/evidence/b.json" \
  >"$tmp/failed-deploy.out" 2>"$tmp/failed-deploy.err"; then
  fail 'failed candidate unexpectedly deployed'
fi
unset AERA_ADMIN_DELIVERY_FAIL_IMAGE
jq -e --arg digest "$digest_a" \
  '.current.imageDigest == $digest and .previous == null' \
  "$tmp/state/deployment-state.json" >/dev/null
test "$(cat "$tmp/state/test-running-image")" = "$reference_a" ||
  fail 'failed update did not restore the recorded Admin digest'

deploy/internal-beta/deploy.sh deploy "$tmp/evidence/b.json"
jq -e --arg current "$digest_b" --arg previous "$digest_a" '
  .current.imageDigest == $current and
  .previous.imageDigest == $previous and
  .mutationsEnabled == false
' "$tmp/state/deployment-state.json" >/dev/null
deploy/internal-beta/deploy.sh rollback
jq -e --arg current "$digest_a" --arg previous "$digest_b" '
  .current.imageDigest == $current and
  .previous.imageDigest == $previous and
  .mutationsEnabled == false
' "$tmp/state/deployment-state.json" >/dev/null
if deploy/internal-beta/deploy.sh rollback "$tmp/evidence/a.json" \
  >"$tmp/rollback-argument.out" 2>"$tmp/rollback-argument.err"; then
  fail 'rollback accepted caller-supplied candidate input'
fi

# Execute the real exposure checker against deterministic local command
# fixtures. It must accept loopback-only publication and reject wildcard
# listeners without probing any real host.
export AERA_INTERNAL_BETA_PUBLIC_ORIGIN=
export AERA_ADMIN_PRIVATE_PORT=19090
deploy/internal-beta/exposure-check.sh
export AERA_ADMIN_TEST_LISTENER=0.0.0.0
if deploy/internal-beta/exposure-check.sh \
  >"$tmp/exposure.out" 2>"$tmp/exposure.err"; then
  fail 'exposure checker accepted a wildcard Admin listener'
fi
unset AERA_ADMIN_TEST_LISTENER

grep -q "^verify $digest_a$" "$command_log"
grep -q "^verify $digest_b$" "$command_log"
grep -q '^cloud-health$' "$command_log"
grep -q '^exposure$' "$command_log"
printf 'internal beta Admin delivery tests passed\n'

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
require_text deploy/internal-beta/gateway.mjs 'MUTATIONS_DISABLED'
require_text deploy/internal-beta/deploy.sh 'verify-manifest\.sh'
require_text deploy/internal-beta/deploy.sh 'candidate digest is already current'
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

AERA_ADMIN_ENV_FILE=/dev/null \
  AERA_ADMIN_PKI_DIR=/tmp \
  AGENTERA_ADMIN_IMAGE_DIGEST=ghcr.io/bignormal/aera-admin@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  docker compose -f deploy/compose.internal-beta.yaml config >/dev/null

node --test scripts/tests/gateway.test.mjs
printf 'internal beta Admin delivery tests passed\n'

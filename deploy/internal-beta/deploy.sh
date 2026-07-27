#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'internal beta Admin deployment failed: %s\n' "$1" >&2
  exit 1
}

require_value() {
  local name=$1
  [[ -n ${!name:-} ]] || fail "$name is required"
}

require_file() {
  [[ -f $1 ]] || fail "required file is missing: $1"
}

[[ $# -ge 1 ]] || fail 'usage: deploy.sh deploy MANIFEST_JSON | rollback'
mode=$1
shift
case "$mode" in
  deploy)
    [[ $# -eq 1 ]] || fail 'deploy requires one candidate manifest'
    supplied_manifest=$1
    ;;
  rollback)
    [[ $# -eq 0 ]] || fail 'rollback takes no candidate manifest'
    supplied_manifest=
    ;;
  *) fail 'mode must be deploy or rollback' ;;
esac

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
state_dir=${AERA_INTERNAL_BETA_ADMIN_STATE_DIR:-/var/lib/aera/internal-beta/admin}
compose_file=${AERA_INTERNAL_BETA_ADMIN_COMPOSE_FILE:-"$repo_root/deploy/compose.internal-beta.yaml"}
compose_project=${AERA_INTERNAL_BETA_ADMIN_COMPOSE_PROJECT:-aera-admin-internal-beta}
verify_command=${AERA_INTERNAL_BETA_ADMIN_VERIFY_COMMAND:-"$repo_root/scripts/release/verify-manifest.sh"}
health_command=${AERA_INTERNAL_BETA_ADMIN_HEALTH_COMMAND:-"$repo_root/deploy/internal-beta/health-smoke.sh"}
cloud_health_command=${AERA_INTERNAL_BETA_ADMIN_CLOUD_HEALTH_COMMAND:-"$repo_root/deploy/internal-beta/cloud-smoke.sh"}
exposure_command=${AERA_INTERNAL_BETA_ADMIN_EXPOSURE_COMMAND:-"$repo_root/deploy/internal-beta/exposure-check.sh"}

require_value AERA_ADMIN_ENV_FILE
require_value AERA_ADMIN_PKI_DIR
require_file "$AERA_ADMIN_ENV_FILE"
[[ -d $AERA_ADMIN_PKI_DIR ]] || fail 'Admin-to-Cloud PKI directory is missing'
for pki_file in ca.pem client.pem client-key.pem service-key.pem; do
  require_file "$AERA_ADMIN_PKI_DIR/$pki_file"
done
require_file "$compose_file"
[[ -x $verify_command ]] || fail 'candidate verifier is not executable'
[[ -x $health_command ]] || fail 'health smoke command is not executable'
[[ -x $cloud_health_command ]] || fail 'Cloud integration smoke command is not executable'
[[ -x $exposure_command ]] || fail 'exposure command is not executable'

export AERA_RELEASE_CERTIFICATE_IDENTITY_REGEXP="${AERA_RELEASE_CERTIFICATE_IDENTITY_REGEXP:-^https://github\\.com/bignormal/aera-admin/\\.github/workflows/candidate\\.yml@refs/heads/main$}"
export AERA_RELEASE_CERTIFICATE_OIDC_ISSUER="${AERA_RELEASE_CERTIFICATE_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"
[[ $AERA_RELEASE_CERTIFICATE_OIDC_ISSUER == https://token.actions.githubusercontent.com ]] ||
  fail 'candidate OIDC issuer must be GitHub Actions'

umask 077
mkdir -p "$state_dir/candidates"
chmod 700 "$state_dir" "$state_dir/candidates"
state_file="$state_dir/deployment-state.json"
current_manifest_file="$state_dir/current-manifest.json"
previous_manifest_file="$state_dir/previous-manifest.json"

manifest_value() {
  jq -er "$2" "$1" 2>/dev/null ||
    fail 'candidate manifest is missing a required identity field'
}

validate_manifest_identity() {
  local manifest=$1
  require_file "$manifest"
  local sha cloud_sha digest image
  sha=$(manifest_value "$manifest" '.commitSha')
  cloud_sha=$(manifest_value "$manifest" '.compatibility.cloudCommitSha')
  digest=$(manifest_value "$manifest" '.image.digest')
  image=$(manifest_value "$manifest" '.image.reference')
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || fail 'candidate source SHA is invalid'
  [[ $cloud_sha =~ ^[0-9a-f]{40}$ ]] || fail 'candidate Cloud SHA is invalid'
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] ||
    fail 'candidate image digest is not immutable'
  [[ $image == "ghcr.io/bignormal/aera-admin@$digest" ]] ||
    fail 'candidate image is not the exact Aera Admin GHCR digest'
}

verify_candidate() {
  local manifest=$1
  local expected_sha=$2
  local expected_cloud_sha=$3
  validate_manifest_identity "$manifest"
  AERA_RELEASE_EXPECTED_SHA="$expected_sha" \
    AERA_RELEASE_EXPECTED_CLOUD_SHA="$expected_cloud_sha" \
    "$verify_command" "$manifest" >/dev/null
}

candidate_relative_path() {
  printf 'candidates/sha256-%s/manifest.json' "${1#sha256:}"
}

candidate_absolute_path() {
  [[ $1 =~ ^candidates/sha256-[0-9a-f]{64}/manifest\.json$ ]] ||
    fail 'recorded candidate path is invalid'
  printf '%s/%s' "$state_dir" "$1"
}

persist_candidate() {
  local manifest=$1
  local digest=$2
  local relative target source_base source_dir
  relative=$(candidate_relative_path "$digest")
  target=$(candidate_absolute_path "$relative")
  mkdir -p "$(dirname "$target")"
  chmod 700 "$(dirname "$target")"
  install -m 600 "$manifest" "$target.tmp"
  mv "$target.tmp" "$target"
  source_base=${manifest%.json}
  source_dir=$(dirname "$manifest")
  if [[ -f $source_base.sigstore.json ]]; then
    install -m 600 "$source_base.sigstore.json" \
      "$(dirname "$target")/manifest.sigstore.json"
  fi
  for evidence in provenance.json sbom.spdx.json; do
    if [[ -f $source_dir/$evidence ]]; then
      install -m 600 "$source_dir/$evidence" "$(dirname "$target")/$evidence"
    fi
  done
  printf '%s' "$relative"
}

compose_image() {
  local image=$1
  shift
  AGENTERA_ADMIN_IMAGE_DIGEST="$image" \
    AERA_ADMIN_ENV_FILE="$AERA_ADMIN_ENV_FILE" \
    AERA_ADMIN_PKI_DIR="$AERA_ADMIN_PKI_DIR" \
    AERA_ADMIN_MUTATIONS_ENABLED=false \
    AERA_ADMIN_PRIVATE_PORT="${AERA_ADMIN_PRIVATE_PORT:-19090}" \
    docker compose \
      --project-name "$compose_project" \
      -f "$compose_file" "$@"
}

start_image() {
  local image=$1
  compose_image "$image" pull payload gateway &&
    compose_image "$image" up -d --force-recreate --wait payload gateway
}

check_image() {
  AERA_ADMIN_PRIVATE_PORT="${AERA_ADMIN_PRIVATE_PORT:-19090}" \
    "$health_command" &&
    AERA_ADMIN_PAYLOAD_CONTAINER="${compose_project}-payload-1" \
      "$cloud_health_command" &&
    AERA_ADMIN_PRIVATE_PORT="${AERA_ADMIN_PRIVATE_PORT:-19090}" \
      AERA_INTERNAL_BETA_PUBLIC_ORIGIN="${AERA_INTERNAL_BETA_PUBLIC_ORIGIN:-}" \
      "$exposure_command"
}

stop_image() {
  compose_image "$1" stop gateway payload >/dev/null 2>&1 || true
}

recorded_manifest() {
  local slot=$1
  local relative
  relative=$(jq -er ".$slot.candidateManifest" "$state_file" 2>/dev/null) ||
    fail "recorded $slot candidate is missing"
  candidate_absolute_path "$relative"
}

verify_recorded_slot() {
  local slot=$1
  local manifest sha cloud_sha state_digest manifest_digest
  manifest=$(recorded_manifest "$slot")
  sha=$(jq -er ".$slot.commitSha" "$state_file")
  cloud_sha=$(jq -er ".$slot.cloudCommitSha" "$state_file")
  state_digest=$(jq -er ".$slot.imageDigest" "$state_file")
  verify_candidate "$manifest" "$sha" "$cloud_sha"
  manifest_digest=$(manifest_value "$manifest" '.image.digest')
  [[ $manifest_digest == "$state_digest" ]] ||
    fail "recorded $slot digest differs from its verified manifest"
  printf '%s' "$manifest"
}

record_deployment() {
  local manifest=$1
  local sha cloud_sha image digest relative now previous
  sha=$(manifest_value "$manifest" '.commitSha')
  cloud_sha=$(manifest_value "$manifest" '.compatibility.cloudCommitSha')
  image=$(manifest_value "$manifest" '.image.reference')
  digest=$(manifest_value "$manifest" '.image.digest')
  relative=$(persist_candidate "$manifest" "$digest")
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ -f $state_file ]]; then
    previous=$(jq -c '.current' "$state_file")
    install -m 600 "$current_manifest_file" "$previous_manifest_file"
  else
    previous=null
  fi
  jq -cnS \
    --arg sha "$sha" \
    --arg cloudSha "$cloud_sha" \
    --arg image "$image" \
    --arg digest "$digest" \
    --arg manifest "$relative" \
    --arg now "$now" \
    --argjson previous "$previous" '
      {
        schemaVersion: 1,
        environment: "internal_beta",
        privateAccess: "ssh_loopback",
        mutationsEnabled: false,
        current: {
          commitSha: $sha,
          cloudCommitSha: $cloudSha,
          imageReference: $image,
          imageDigest: $digest,
          candidateManifest: $manifest,
          deployedAt: $now
        },
        previous: $previous,
        updatedAt: $now
      }
    ' >"$state_file.tmp"
  chmod 600 "$state_file.tmp"
  mv "$state_file.tmp" "$state_file"
  install -m 600 "$manifest" "$current_manifest_file"
}

deploy_candidate() {
  require_value AERA_INTERNAL_BETA_ADMIN_EXPECTED_SHA
  require_value AERA_INTERNAL_BETA_ADMIN_EXPECTED_CLOUD_SHA
  local manifest=$1
  verify_candidate \
    "$manifest" \
    "$AERA_INTERNAL_BETA_ADMIN_EXPECTED_SHA" \
    "$AERA_INTERNAL_BETA_ADMIN_EXPECTED_CLOUD_SHA"
  local image digest previous_manifest previous_image
  image=$(manifest_value "$manifest" '.image.reference')
  digest=$(manifest_value "$manifest" '.image.digest')
  previous_manifest=
  previous_image=
  if [[ -f $state_file ]]; then
    previous_manifest=$(verify_recorded_slot current)
    previous_image=$(manifest_value "$previous_manifest" '.image.reference')
    [[ $(manifest_value "$previous_manifest" '.image.digest') != "$digest" ]] ||
      fail 'candidate digest is already current'
  fi
  if ! start_image "$image" || ! check_image; then
    if [[ -n $previous_image ]] &&
      start_image "$previous_image" &&
      check_image; then
      fail 'candidate failed and was returned to the recorded digest'
    fi
    stop_image "$image"
    fail 'candidate failed and no verified previous Admin could be restored'
  fi
  record_deployment "$manifest"
  printf 'internal beta Admin deployed private and disabled: %s\n' "$digest"
}

rollback_recorded() {
  [[ -f $state_file ]] || fail 'deployment state is missing'
  jq -e '.previous != null' "$state_file" >/dev/null ||
    fail 'no recorded previous candidate is available'
  local current_manifest target_manifest current_image target_image
  local target_sha target_cloud_sha target_digest target_relative now old_current
  current_manifest=$(verify_recorded_slot current)
  target_manifest=$(verify_recorded_slot previous)
  current_image=$(manifest_value "$current_manifest" '.image.reference')
  target_image=$(manifest_value "$target_manifest" '.image.reference')
  target_sha=$(manifest_value "$target_manifest" '.commitSha')
  target_cloud_sha=$(manifest_value "$target_manifest" '.compatibility.cloudCommitSha')
  target_digest=$(manifest_value "$target_manifest" '.image.digest')
  target_relative=$(candidate_relative_path "$target_digest")
  if ! start_image "$target_image" || ! check_image; then
    start_image "$current_image" && check_image ||
      stop_image "$current_image"
    fail 'recorded rollback failed'
  fi
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  old_current=$(jq -c '.current' "$state_file")
  jq -cS \
    --arg sha "$target_sha" \
    --arg cloudSha "$target_cloud_sha" \
    --arg image "$target_image" \
    --arg digest "$target_digest" \
    --arg manifest "$target_relative" \
    --arg now "$now" \
    --argjson previous "$old_current" '
      .current = {
        commitSha: $sha,
        cloudCommitSha: $cloudSha,
        imageReference: $image,
        imageDigest: $digest,
        candidateManifest: $manifest,
        deployedAt: $now
      } |
      .previous = $previous |
      .mutationsEnabled = false |
      .updatedAt = $now
    ' "$state_file" >"$state_file.tmp"
  chmod 600 "$state_file.tmp"
  mv "$state_file.tmp" "$state_file"
  install -m 600 "$current_manifest" "$previous_manifest_file"
  install -m 600 "$target_manifest" "$current_manifest_file"
  printf 'internal beta Admin rolled back to recorded digest: %s\n' "$target_digest"
}

case "$mode" in
  deploy) deploy_candidate "$supplied_manifest" ;;
  rollback) rollback_recorded ;;
esac

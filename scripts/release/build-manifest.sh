#!/bin/sh
set -eu

fail() {
  printf 'Admin candidate manifest build failed: %s\n' "$*" >&2
  exit 1
}

require() {
  name=$1
  eval "value=\${$name:-}"
  test -n "$value" || fail "$name is required"
}

test "$#" -eq 1 || fail "usage: build-manifest.sh OUTPUT_JSON"
command -v git >/dev/null 2>&1 || fail "git is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"

for name in \
  AERA_RELEASE_REPOSITORY \
  AERA_RELEASE_COMMIT_SHA \
  AERA_RELEASE_IMAGE \
  AERA_RELEASE_IMAGE_DIGEST \
  AERA_RELEASE_WORKFLOW \
  AERA_RELEASE_RUN_URL \
  AERA_RELEASE_ADMIN_SCHEMA_MIN \
  AERA_RELEASE_ADMIN_SCHEMA_MAX \
  AERA_RELEASE_ADMIN_HIGHEST_MIGRATION \
  AERA_RELEASE_CLOUD_COMMIT_SHA \
  AERA_RELEASE_CLOUD_SCHEMA_MIN \
  AERA_RELEASE_CLOUD_SCHEMA_MAX \
  AERA_RELEASE_SBOM_DIGEST \
  AERA_RELEASE_PROVENANCE_DIGEST \
  AERA_RELEASE_CREATED_AT
do
  require "$name"
done

git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  fail "source must be a Git worktree"
test -z "$(git status --porcelain=v1)" || fail "source tree is dirty"
test "$(git rev-parse HEAD)" = "$AERA_RELEASE_COMMIT_SHA" ||
  fail "AERA_RELEASE_COMMIT_SHA does not match HEAD"
test "$AERA_RELEASE_REPOSITORY" = "bignormal/aera-admin" ||
  fail "repository must be bignormal/aera-admin"
test "$AERA_RELEASE_IMAGE" = "ghcr.io/bignormal/aera-admin" ||
  fail "image repository must be the canonical Admin GHCR repository"
test "$AERA_RELEASE_WORKFLOW" = "Admin candidate" ||
  fail "workflow must be Admin candidate"

for sha in "$AERA_RELEASE_COMMIT_SHA" "$AERA_RELEASE_CLOUD_COMMIT_SHA"; do
  printf '%s\n' "$sha" | grep -Eq '^[0-9a-f]{40}$' ||
    fail "commit SHAs must be 40 lowercase hexadecimal characters"
done
for digest in \
  "$AERA_RELEASE_IMAGE_DIGEST" \
  "$AERA_RELEASE_SBOM_DIGEST" \
  "$AERA_RELEASE_PROVENANCE_DIGEST"
do
  printf '%s\n' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
    fail "candidate digests must be immutable sha256"
done
printf '%s\n' "$AERA_RELEASE_RUN_URL" |
  grep -Eq '^https://github\.com/bignormal/aera-admin/actions/runs/[1-9][0-9]*$' ||
  fail "run URL must be an exact Admin GitHub Actions run"

for value in \
  "$AERA_RELEASE_ADMIN_SCHEMA_MIN" \
  "$AERA_RELEASE_ADMIN_SCHEMA_MAX" \
  "$AERA_RELEASE_ADMIN_HIGHEST_MIGRATION" \
  "$AERA_RELEASE_CLOUD_SCHEMA_MIN" \
  "$AERA_RELEASE_CLOUD_SCHEMA_MAX"
do
  case "$value" in
    *[!0-9]*|"") fail "schema versions must be positive integers" ;;
  esac
  test "$value" -gt 0 || fail "schema versions must be positive integers"
done
test "$AERA_RELEASE_ADMIN_SCHEMA_MIN" -le "$AERA_RELEASE_ADMIN_HIGHEST_MIGRATION" ||
  fail "Admin highest migration is below the schema minimum"
test "$AERA_RELEASE_ADMIN_HIGHEST_MIGRATION" -le "$AERA_RELEASE_ADMIN_SCHEMA_MAX" ||
  fail "Admin highest migration exceeds the schema maximum"
test "$AERA_RELEASE_CLOUD_SCHEMA_MIN" -le "$AERA_RELEASE_CLOUD_SCHEMA_MAX" ||
  fail "Cloud compatibility range is invalid"

image_reference="${AERA_RELEASE_IMAGE}@${AERA_RELEASE_IMAGE_DIGEST}"
jq -cnS \
  --arg repository "$AERA_RELEASE_REPOSITORY" \
  --arg commitSha "$AERA_RELEASE_COMMIT_SHA" \
  --arg imageReference "$image_reference" \
  --arg imageDigest "$AERA_RELEASE_IMAGE_DIGEST" \
  --arg workflow "$AERA_RELEASE_WORKFLOW" \
  --arg runUrl "$AERA_RELEASE_RUN_URL" \
  --argjson adminMinimum "$AERA_RELEASE_ADMIN_SCHEMA_MIN" \
  --argjson adminMaximum "$AERA_RELEASE_ADMIN_SCHEMA_MAX" \
  --argjson adminHighest "$AERA_RELEASE_ADMIN_HIGHEST_MIGRATION" \
  --arg cloudCommitSha "$AERA_RELEASE_CLOUD_COMMIT_SHA" \
  --argjson cloudMinimum "$AERA_RELEASE_CLOUD_SCHEMA_MIN" \
  --argjson cloudMaximum "$AERA_RELEASE_CLOUD_SCHEMA_MAX" \
  --arg sbomDigest "$AERA_RELEASE_SBOM_DIGEST" \
  --arg provenanceDigest "$AERA_RELEASE_PROVENANCE_DIGEST" \
  --arg createdAt "$AERA_RELEASE_CREATED_AT" \
  '{
    schemaVersion: 1,
    repository: $repository,
    commitSha: $commitSha,
    image: {
      reference: $imageReference,
      digest: $imageDigest
    },
    build: {
      workflow: $workflow,
      runUrl: $runUrl
    },
    adminSchema: {
      minimum: $adminMinimum,
      maximum: $adminMaximum,
      highestMigration: $adminHighest
    },
    compatibility: {
      cloudCommitSha: $cloudCommitSha,
      cloudInternalApiVersion: "v1",
      cloudSchemaMinimum: $cloudMinimum,
      cloudSchemaMaximum: $cloudMaximum
    },
    supplyChain: {
      sbomDigest: $sbomDigest,
      provenanceDigest: $provenanceDigest
    },
    mutationsEnabledByDefault: false,
    createdAt: $createdAt
  }' > "$1"
printf '\n' >> "$1"

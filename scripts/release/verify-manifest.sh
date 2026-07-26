#!/bin/sh
set -eu

fail() {
  printf 'Admin candidate manifest verification failed: %s\n' "$*" >&2
  exit 1
}

test "$#" -eq 1 || fail "usage: verify-manifest.sh MANIFEST_JSON"
manifest=$1
test -f "$manifest" || fail "manifest is missing"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v cosign >/dev/null 2>&1 || fail "cosign is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"

expected_sha=${AERA_RELEASE_EXPECTED_SHA:-}
expected_cloud_sha=${AERA_RELEASE_EXPECTED_CLOUD_SHA:-}
identity=${AERA_RELEASE_CERTIFICATE_IDENTITY_REGEXP:-}
issuer=${AERA_RELEASE_CERTIFICATE_OIDC_ISSUER:-}
test -n "$expected_sha" || fail "AERA_RELEASE_EXPECTED_SHA is required"
test -n "$expected_cloud_sha" || fail "AERA_RELEASE_EXPECTED_CLOUD_SHA is required"
test -n "$identity" || fail "AERA_RELEASE_CERTIFICATE_IDENTITY_REGEXP is required"
test "$issuer" = "https://token.actions.githubusercontent.com" ||
  fail "OIDC issuer must be GitHub Actions"

case "$manifest" in
  *.json) manifest_base=${manifest%.json} ;;
  *) fail "manifest must use a .json filename" ;;
esac
evidence_dir=$(dirname "$manifest")
manifest_bundle="$manifest_base.sigstore.json"
provenance="$evidence_dir/provenance.json"
sbom="$evidence_dir/sbom.spdx.json"
test -f "$manifest_bundle" || fail "manifest Sigstore bundle is missing"
test -f "$provenance" || fail "SLSA provenance predicate is missing"
test -f "$sbom" || fail "SPDX SBOM is missing"
attestation_output=$(mktemp "${TMPDIR:-/tmp}/aera-admin-attestation.XXXXXX")
trap 'rm -f "$attestation_output"' EXIT HUP INT TERM

jq -e '
  type == "object" and
  keys == [
    "adminSchema", "build", "commitSha", "compatibility", "createdAt",
    "image", "mutationsEnabledByDefault", "repository", "schemaVersion",
    "supplyChain"
  ] and
  .schemaVersion == 1 and
  .repository == "bignormal/aera-admin" and
  (.commitSha | test("^[0-9a-f]{40}$")) and
  (.image.digest | test("^sha256:[0-9a-f]{64}$")) and
  .build.workflow == "Admin candidate" and
  (.build.runUrl | test("^https://github.com/bignormal/aera-admin/actions/runs/[1-9][0-9]*$")) and
  (.adminSchema | keys == ["highestMigration", "maximum", "minimum"]) and
  (.adminSchema.minimum | type == "number" and floor == . and . > 0) and
  (.adminSchema.maximum | type == "number" and floor == . and . > 0) and
  (.adminSchema.highestMigration | type == "number" and floor == . and . > 0) and
  (.adminSchema.minimum <= .adminSchema.highestMigration) and
  (.adminSchema.highestMigration <= .adminSchema.maximum) and
  (.compatibility | keys == [
    "cloudCommitSha", "cloudInternalApiVersion",
    "cloudSchemaMaximum", "cloudSchemaMinimum"
  ]) and
  (.compatibility.cloudCommitSha | test("^[0-9a-f]{40}$")) and
  .compatibility.cloudInternalApiVersion == "v1" and
  (.compatibility.cloudSchemaMinimum | type == "number" and floor == . and . > 0) and
  (.compatibility.cloudSchemaMaximum | type == "number" and floor == . and . > 0) and
  (.compatibility.cloudSchemaMinimum <= .compatibility.cloudSchemaMaximum) and
  (.supplyChain | keys == ["provenanceDigest", "sbomDigest"]) and
  (.supplyChain.sbomDigest | test("^sha256:[0-9a-f]{64}$")) and
  (.supplyChain.provenanceDigest | test("^sha256:[0-9a-f]{64}$")) and
  .mutationsEnabledByDefault == false and
  (.createdAt | fromdateiso8601 | type == "number")
' "$manifest" >/dev/null || fail "manifest schema or required evidence is invalid"

canonical=$(jq -cS . "$manifest")
actual=$(tr -d '\n' < "$manifest")
test "$actual" = "$canonical" || fail "manifest is not canonical JSON"

commit_sha=$(jq -r '.commitSha' "$manifest")
cloud_sha=$(jq -r '.compatibility.cloudCommitSha' "$manifest")
test "$commit_sha" = "$expected_sha" || fail "manifest source SHA does not match"
test "$cloud_sha" = "$expected_cloud_sha" ||
  fail "manifest Cloud compatibility SHA does not match"
image=$(jq -r '.image.reference' "$manifest")
digest=$(jq -r '.image.digest' "$manifest")
test "$image" = "ghcr.io/bignormal/aera-admin@$digest" ||
  fail "image reference is mutable or not the canonical Admin image"

expected_sbom_digest=$(jq -r '.supplyChain.sbomDigest' "$manifest")
actual_sbom_digest="sha256:$(sha256sum "$sbom" | cut -d' ' -f1)"
test "$actual_sbom_digest" = "$expected_sbom_digest" ||
  fail "SBOM digest does not match the manifest"
jq -e 'type == "object" and .spdxVersion == "SPDX-2.3"' "$sbom" >/dev/null ||
  fail "SBOM is not an SPDX 2.3 JSON document"

expected_provenance_digest=$(jq -r '.supplyChain.provenanceDigest' "$manifest")
actual_provenance_digest="sha256:$(sha256sum "$provenance" | cut -d' ' -f1)"
test "$actual_provenance_digest" = "$expected_provenance_digest" ||
  fail "provenance digest does not match the manifest"
test "$(tr -d '\n' < "$provenance")" = "$(jq -cS . "$provenance")" ||
  fail "provenance predicate is not canonical JSON"

run_url=$(jq -r '.build.runUrl' "$manifest")
digest_hex=${digest#sha256:}
jq -e \
  --arg sourceSha "$commit_sha" \
  --arg runUrl "$run_url" \
  --arg image "$image" \
  --arg digest "$digest_hex" \
  --arg identity "$identity" '
    keys == ["buildDefinition", "runDetails"] and
    .buildDefinition.buildType == "https://slsa.dev/provenance/v1" and
    .buildDefinition.externalParameters.repository ==
      "https://github.com/bignormal/aera-admin" and
    .buildDefinition.externalParameters.sourceSha == $sourceSha and
    .buildDefinition.externalParameters.workflowPath ==
      ".github/workflows/candidate.yml" and
    (.buildDefinition.externalParameters.workflowRef |
      test("^refs/heads/[A-Za-z0-9._/-]+$")) and
    .buildDefinition.externalParameters.runUrl == $runUrl and
    .buildDefinition.externalParameters.image == $image and
    .buildDefinition.resolvedDependencies == [{
      uri: (
        "git+https://github.com/bignormal/aera-admin@" +
        .buildDefinition.externalParameters.workflowRef
      ),
      digest: {gitCommit: $sourceSha}
    }] and
    (.runDetails.builder.id | test($identity)) and
    .runDetails.metadata == {invocationId: $runUrl} and
    .runDetails.byproducts == [{
      name: $image,
      digest: {sha256: $digest}
    }]
  ' "$provenance" >/dev/null ||
  fail "provenance does not bind the exact source, workflow, run, and image"

cosign verify \
  --certificate-identity-regexp "$identity" \
  --certificate-oidc-issuer "$issuer" \
  "$image" >/dev/null ||
  fail "image signature verification failed"
cosign verify-attestation \
  --type slsaprovenance1 \
  --certificate-identity-regexp "$identity" \
  --certificate-oidc-issuer "$issuer" \
  "$image" > "$attestation_output" ||
  fail "image provenance attestation verification failed"

if ! jq -e \
  --slurp \
  --slurpfile expected "$provenance" \
  --arg image "ghcr.io/bignormal/aera-admin" \
  --arg digest "$digest_hex" '
    [
      .[] | .. | objects |
      select((.payload? | type) == "string") |
      (try (.payload | @base64d | fromjson) catch empty) |
      select(._type == "https://in-toto.io/Statement/v0.1") |
      select(.predicateType == "https://slsa.dev/provenance/v1") |
      select(.subject == [{name: $image, digest: {sha256: $digest}}]) |
      select(.predicate == $expected[0])
    ] | length >= 1
  ' "$attestation_output" >/dev/null; then
  fail "verified attestation does not contain the reviewed provenance predicate"
fi

cosign verify-blob "$manifest" \
  --bundle "$manifest_bundle" \
  --certificate-identity-regexp "$identity" \
  --certificate-oidc-issuer "$issuer" >/dev/null ||
  fail "manifest Sigstore bundle verification failed"

printf 'Admin candidate manifest verified: %s at %s\n' "$commit_sha" "$digest"

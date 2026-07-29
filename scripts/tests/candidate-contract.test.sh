#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
build="$root/scripts/release/build-manifest.sh"
provenance_build="$root/scripts/release/build-provenance.sh"
verify="$root/scripts/release/verify-manifest.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/aera-admin-candidate.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

repo="$tmp/repo"
mkdir -p "$repo" "$tmp/bin" "$tmp/evidence"
git -C "$repo" init -q
git -C "$repo" config user.email candidate-test@invalid.example
git -C "$repo" config user.name candidate-test
printf 'fixture\n' >"$repo/source.txt"
git -C "$repo" add source.txt
git -C "$repo" commit -qm fixture
sha=$(git -C "$repo" rev-parse HEAD)
cloud_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
digest=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc

cat >"$tmp/bin/cosign" <<'SH'
#!/bin/sh
set -eu
case "$1" in
  verify) ;;
  verify-attestation)
    digest=${COSIGN_TEST_IMAGE##*@sha256:}
    image=${COSIGN_TEST_IMAGE%@*}
    statement=$(jq -cn \
      --arg image "$image" \
      --arg digest "$digest" \
      --slurpfile predicate "$COSIGN_TEST_PROVENANCE" '
        {
          _type: "https://in-toto.io/Statement/v0.1",
          subject: [{name: $image, digest: {sha256: $digest}}],
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: $predicate[0]
        }
      ')
    payload=$(printf '%s' "$statement" | base64 | tr -d '\n')
    jq -cn --arg payload "$payload" '{payload:$payload}'
    ;;
  verify-blob)
    bundle=
    previous=
    for argument in "$@"; do
      if test "$previous" = "--bundle"; then bundle=$argument; fi
      previous=$argument
    done
    test -f "$bundle"
    ;;
  *) exit 1 ;;
esac
SH
chmod +x "$tmp/bin/cosign"
export PATH="$tmp/bin:$PATH"

export AERA_RELEASE_REPOSITORY=bignormal/aera-admin
export AERA_RELEASE_COMMIT_SHA="$sha"
export AERA_RELEASE_IMAGE=ghcr.io/bignormal/aera-admin
export AERA_RELEASE_IMAGE_DIGEST="$digest"
export AERA_RELEASE_WORKFLOW="Admin candidate"
export AERA_RELEASE_RUN_URL=https://github.com/bignormal/aera-admin/actions/runs/1234
export AERA_RELEASE_ADMIN_SCHEMA_MIN=1
export AERA_RELEASE_ADMIN_SCHEMA_MAX=1
export AERA_RELEASE_ADMIN_HIGHEST_MIGRATION=1
export AERA_RELEASE_CLOUD_COMMIT_SHA="$cloud_sha"
export AERA_RELEASE_CLOUD_SCHEMA_MIN=17
export AERA_RELEASE_CLOUD_SCHEMA_MAX=21
export AERA_RELEASE_CREATED_AT=2026-07-27T00:00:00Z
export AERA_RELEASE_EXPECTED_SHA="$sha"
export AERA_RELEASE_EXPECTED_CLOUD_SHA="$cloud_sha"
export AERA_RELEASE_CERTIFICATE_IDENTITY_REGEXP='^https://github.com/bignormal/aera-admin/'
export AERA_RELEASE_CERTIFICATE_OIDC_ISSUER=https://token.actions.githubusercontent.com

export AERA_PROVENANCE_REPOSITORY=bignormal/aera-admin
export AERA_PROVENANCE_SOURCE_SHA="$sha"
export AERA_PROVENANCE_WORKFLOW_PATH=.github/workflows/candidate.yml
export AERA_PROVENANCE_WORKFLOW_REF=refs/heads/main
export AERA_PROVENANCE_RUN_URL="$AERA_RELEASE_RUN_URL"
export AERA_PROVENANCE_BUILDER_ID=https://github.com/bignormal/aera-admin/.github/workflows/candidate.yml@refs/heads/main
export AERA_PROVENANCE_IMAGE_REFERENCE="ghcr.io/bignormal/aera-admin@$digest"
export AERA_PROVENANCE_IMAGE_DIGEST="$digest"

evidence="$tmp/evidence"
"$provenance_build" "$evidence/provenance.json"
printf '{"SPDXID":"SPDXRef-DOCUMENT","spdxVersion":"SPDX-2.3"}\n' \
  >"$evidence/sbom.spdx.json"
export AERA_RELEASE_SBOM_DIGEST="sha256:$(sha256sum "$evidence/sbom.spdx.json" | cut -d' ' -f1)"
export AERA_RELEASE_PROVENANCE_DIGEST="sha256:$(sha256sum "$evidence/provenance.json" | cut -d' ' -f1)"
(
  cd "$repo"
  "$build" "$evidence/manifest.json"
)
printf '{}\n' >"$evidence/manifest.sigstore.json"
export COSIGN_TEST_IMAGE="$AERA_PROVENANCE_IMAGE_REFERENCE"
export COSIGN_TEST_PROVENANCE="$evidence/provenance.json"
"$verify" "$evidence/manifest.json"

jq -e \
  --arg sha "$sha" \
  --arg cloud "$cloud_sha" '
    .repository == "bignormal/aera-admin" and
    .commitSha == $sha and
    .adminSchema == {minimum: 1, maximum: 1, highestMigration: 1} and
    .compatibility == {
      cloudCommitSha: $cloud,
      cloudInternalApiVersion: "v1",
      cloudSchemaMinimum: 17,
      cloudSchemaMaximum: 21
    } and
    .mutationsEnabledByDefault == false
  ' "$evidence/manifest.json" >/dev/null

expect_failure() {
  label=$1
  candidate=$2
  if "$verify" "$candidate" >"$tmp/$label.out" 2>"$tmp/$label.err"; then
    printf '%s unexpectedly passed\n' "$label" >&2
    exit 1
  fi
}

jq -cS '.image.reference = "ghcr.io/bignormal/aera-admin:latest"' \
  "$evidence/manifest.json" >"$tmp/mutable.json"
expect_failure mutable "$tmp/mutable.json"
jq -cS '.compatibility.cloudCommitSha = "dddddddddddddddddddddddddddddddddddddddd"' \
  "$evidence/manifest.json" >"$tmp/wrong-cloud.json"
expect_failure wrong-cloud "$tmp/wrong-cloud.json"
jq -cS '.mutationsEnabledByDefault = true' \
  "$evidence/manifest.json" >"$tmp/mutations-enabled.json"
expect_failure mutations-enabled "$tmp/mutations-enabled.json"

printf 'candidate contract tests passed\n'

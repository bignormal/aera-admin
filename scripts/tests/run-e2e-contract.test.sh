#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
runner="$root/scripts/run-e2e.sh"

test ! -e "$root/e2e/cloud-stub/main.go"
grep -q 'AERA_ADMIN_E2E_CLOUD_REPO' "$runner"
grep -q 'Cloud repository must be provided explicitly' "$runner"
grep -q 'git -C "$cloud_repo" status --porcelain' "$runner"
grep -q 'git -C "$cloud_repo" rev-parse --show-toplevel' "$runner"
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
grep -q 'official_agents:read' "$runner"
grep -q 'official_agent_drafts:write' "$runner"
grep -q 'official_agent_reviews:write' "$runner"
grep -q 'official_agent_releases:write' "$runner"
grep -q 'official_agent_audit:read' "$runner"
grep -q 'AGENTERA_CLOUD_OFFICIAL_AGENTS_ENABLED=true' "$runner"
grep -q 'AGENTERA_CLOUD_OFFICIAL_ROLLOUT_HMAC_KEYS' "$runner"
grep -q 'AERA_ADMIN_E2E_CLOUD_PID_FILE' "$runner"
grep -q 'final service status follows' "$runner"
grep -q './internal/officialagent' "$root/Makefile"
grep -q 'stopRealCloud' "$root/e2e/official-agent.spec.ts"
grep -q "official_release_rollback" "$root/e2e/official-agent.spec.ts"
grep -q 'async function updateDraft' "$root/e2e/official-agent.spec.ts"
grep -q "}, 'PATCH');" "$root/e2e/official-agent.spec.ts"
grep -q 'OFFICIAL-REVIEWER' "$root/e2e/global-setup.ts"
grep -q 'E2E-OFFICIAL-OPERATOR' "$root/e2e/global-setup.ts"
grep -q 'official_audience_user_id' "$root/e2e/support.ts"
grep -q '真实 aera-cloud' "$root/README.md"
grep -q '官方 Agent' "$root/README.md"

if grep -Eq '真实 Internal Admin API 尚未.*实现' "$root/README.md"; then
  echo 'README still claims that the real Cloud Internal Admin API is unimplemented' >&2
  exit 1
fi

if grep -q 'cloud-stub' "$runner" "$root/Makefile"; then
  echo 'real Cloud E2E still references the Stub' >&2
  exit 1
fi

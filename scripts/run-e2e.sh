#!/bin/sh
set -eu
umask 077

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cloud_repo=${AERA_ADMIN_E2E_CLOUD_REPO:-}
if [ -z "$cloud_repo" ]; then
  common_dir=$(git -C "$repository_root" rev-parse --git-common-dir)
  case "$common_dir" in
    /*) ;;
    *) common_dir="$repository_root/$common_dir" ;;
  esac
  canonical_admin=$(CDPATH= cd -- "$(dirname -- "$common_dir")" && pwd -P)
  cloud_repo=$(CDPATH= cd -- "$canonical_admin/../aera-cloud" && pwd -P)
else
  cloud_repo=$(CDPATH= cd -- "$cloud_repo" && pwd -P)
fi

if [ "$(sed -n 's/^module //p' "$cloud_repo/go.mod")" != 'github.com/bignormal/aera-cloud' ]; then
  echo "Aera Admin E2E Cloud repository has an unexpected Go module" >&2
  exit 1
fi
if ! cmp "$repository_root/api/openapi/cloud-admin-client.yaml" "$cloud_repo/api/openapi/internal-admin.yaml" >/dev/null; then
  echo "Aera Admin and Cloud Internal Admin OpenAPI contracts differ" >&2
  exit 1
fi
if [ ! -f "$cloud_repo/.env.example" ] || [ ! -f "$cloud_repo/compose.yaml" ]; then
  echo "Aera Admin E2E Cloud repository is incomplete" >&2
  exit 1
fi

tmp_parent=$(CDPATH= cd -- "${TMPDIR:-/tmp}" && pwd -P)
e2e_tmp_dir=$(mktemp -d "$tmp_parent/aera-admin-e2e.XXXXXX")
e2e_tmp_dir=$(CDPATH= cd -- "$e2e_tmp_dir" && pwd -P)
case "$e2e_tmp_dir" in
  "$tmp_parent"/aera-admin-e2e.*) ;;
  *) echo "refusing unsafe E2E temporary directory" >&2; exit 1 ;;
esac
run_token=$(basename "$e2e_tmp_dir" | sed 's/^aera-admin-e2e\.//' | tr '[:upper:]' '[:lower:]')
case "$run_token" in
  ''|*[!a-z0-9]*) echo "refusing unsafe E2E run token" >&2; exit 1 ;;
esac
admin_project="aera_admin_e2e_$run_token"
cloud_project="aera_cloud_e2e_$run_token"
e2e_lock_dir="$tmp_parent/aera-admin-real-cloud-e2e.lock"
if ! mkdir "$e2e_lock_dir" 2>/dev/null; then
  rmdir "$e2e_tmp_dir"
  echo "another Aera Admin real-Cloud E2E run owns the local application ports" >&2
  exit 1
fi

server_binary="$e2e_tmp_dir/aera-admin"
bootstrap_binary="$e2e_tmp_dir/aera-admin-bootstrap"
cloud_binary="$e2e_tmp_dir/aera-cloud"
cloud_e2e_binary="$e2e_tmp_dir/aera-cloud-e2e"
fixture_file="$e2e_tmp_dir/fixtures.json"
cloud_fixture_file="$e2e_tmp_dir/cloud-fixture.json"
server_log="$e2e_tmp_dir/server.log"
cloud_log="$e2e_tmp_dir/cloud.log"
pki_dir="$e2e_tmp_dir/pki"
artifact_dir="$e2e_tmp_dir/test-results"
server_pid=""
cloud_pid=""
admin_compose_started=false
cloud_compose_started=false

safe_compose_down() {
  compose_root=$1
  compose_project=$2
  expected_prefix=$3
  suffix=${compose_project#"$expected_prefix"}
  if [ "$suffix" = "$compose_project" ]; then
    echo "refusing unsafe Compose cleanup" >&2
    return 1
  fi
  case "$suffix" in
    ''|*[!a-z0-9]*) echo "refusing unsafe Compose cleanup" >&2; return 1 ;;
  esac
  docker compose -p "$compose_project" -f "$compose_root/compose.yaml" down -v --remove-orphans
}

stop_owned_process() {
  owned_pid=$1
  case "$owned_pid" in
    ''|*[!0-9]*) return 0 ;;
  esac
  kill "$owned_pid" 2>/dev/null || true
  wait "$owned_pid" 2>/dev/null || true
}

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM
  stop_owned_process "$server_pid"
  stop_owned_process "$cloud_pid"
  if [ "$admin_compose_started" = true ]; then
    safe_compose_down "$repository_root" "$admin_project" 'aera_admin_e2e_' >/dev/null 2>&1 || true
  fi
  if [ "$cloud_compose_started" = true ]; then
    safe_compose_down "$cloud_repo" "$cloud_project" 'aera_cloud_e2e_' >/dev/null 2>&1 || true
  fi
  case "$e2e_tmp_dir" in
    "$tmp_parent"/aera-admin-e2e.*) rm -rf -- "$e2e_tmp_dir" ;;
    *) echo "refusing unsafe E2E temporary cleanup" >&2 ;;
  esac
  if [ "$e2e_lock_dir" = "$tmp_parent/aera-admin-real-cloud-e2e.lock" ]; then
    rmdir "$e2e_lock_dir" 2>/dev/null || true
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT INT TERM

export AERA_ADMIN_POSTGRES_BIND=127.0.0.1:
export AERA_ADMIN_REDIS_BIND=127.0.0.1:
export AERA_CLOUD_POSTGRES_BIND=127.0.0.1:
export AERA_CLOUD_REDIS_BIND=127.0.0.1:

admin_compose_started=true
docker compose -p "$admin_project" -f "$repository_root/compose.yaml" up -d --wait postgres redis
cloud_compose_started=true
docker compose -p "$cloud_project" -f "$cloud_repo/compose.yaml" up -d --wait postgres redis

admin_postgres_endpoint=$(docker compose -p "$admin_project" -f "$repository_root/compose.yaml" port postgres 5432)
admin_redis_endpoint=$(docker compose -p "$admin_project" -f "$repository_root/compose.yaml" port redis 6379)
cloud_postgres_endpoint=$(docker compose -p "$cloud_project" -f "$cloud_repo/compose.yaml" port postgres 5432)
cloud_redis_endpoint=$(docker compose -p "$cloud_project" -f "$cloud_repo/compose.yaml" port redis 6379)
for endpoint in "$admin_postgres_endpoint" "$admin_redis_endpoint" "$cloud_postgres_endpoint" "$cloud_redis_endpoint"; do
  case "$endpoint" in
    127.0.0.1:[0-9]*) ;;
    *) echo "E2E dependency was not bound to numeric loopback" >&2; exit 1 ;;
  esac
  endpoint_port=${endpoint##*:}
  case "$endpoint_port" in
    ''|*[!0-9]*) echo "E2E dependency port is invalid" >&2; exit 1 ;;
  esac
done
admin_postgres_port=${admin_postgres_endpoint##*:}
admin_redis_port=${admin_redis_endpoint##*:}
cloud_postgres_port=${cloud_postgres_endpoint##*:}
cloud_redis_port=${cloud_redis_endpoint##*:}

cd "$repository_root"
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm --filter @aera/admin-web build
go build -tags release -trimpath -o "$server_binary" ./cmd/aera-admin
go build -trimpath -o "$bootstrap_binary" ./cmd/aera-admin-bootstrap
(cd "$cloud_repo" && go build -trimpath -o "$cloud_binary" ./cmd/aera-cloud)
(cd "$cloud_repo" && go build -tags e2e -trimpath -o "$cloud_e2e_binary" ./cmd/aera-cloud-e2e)

mkdir -m 700 "$pki_dir"
openssl req -x509 -newkey rsa:3072 -nodes -days 1 -subj '/CN=Aera Admin E2E CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$pki_dir/ca-key.pem" -out "$pki_dir/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:3072 -nodes -subj '/CN=127.0.0.1' \
  -keyout "$pki_dir/cloud-key.pem" -out "$pki_dir/cloud.csr" >/dev/null 2>&1
printf 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' >"$pki_dir/cloud.ext"
openssl x509 -req -days 1 -in "$pki_dir/cloud.csr" -CA "$pki_dir/ca.pem" -CAkey "$pki_dir/ca-key.pem" -CAcreateserial \
  -extfile "$pki_dir/cloud.ext" -out "$pki_dir/cloud.pem" >/dev/null 2>&1
openssl req -newkey rsa:3072 -nodes -subj '/CN=aera-admin-e2e' \
  -keyout "$pki_dir/client-key.pem" -out "$pki_dir/client.csr" >/dev/null 2>&1
printf 'extendedKeyUsage=clientAuth\n' >"$pki_dir/client.ext"
openssl x509 -req -days 1 -in "$pki_dir/client.csr" -CA "$pki_dir/ca.pem" -CAkey "$pki_dir/ca-key.pem" -CAcreateserial \
  -extfile "$pki_dir/client.ext" -out "$pki_dir/client.pem" >/dev/null 2>&1
openssl genpkey -algorithm ED25519 -out "$pki_dir/service-key.pem" >/dev/null 2>&1
openssl pkey -in "$pki_dir/service-key.pem" -pubout -out "$pki_dir/service-public.pem" >/dev/null 2>&1

admin_identity_encryption_key=$(openssl rand -base64 32 | tr -d '\n')
admin_identity_lookup_key=$(openssl rand -base64 32 | tr -d '\n')
admin_totp_encryption_key=$(openssl rand -base64 32 | tr -d '\n')
admin_session_hmac_key=$(openssl rand -base64 32 | tr -d '\n')
admin_csrf_hmac_key=$(openssl rand -base64 32 | tr -d '\n')
admin_operation_hmac_key=$(openssl rand -base64 32 | tr -d '\n')
cloud_identity_encryption_key=$(openssl rand -base64 32 | tr -d '\n')
cloud_identity_lookup_key=$(openssl rand -base64 32 | tr -d '\n')
cloud_internal_hmac_key=$(openssl rand -base64 32 | tr -d '\n')

export AERA_ADMIN_ENVIRONMENT=test
export AERA_ADMIN_LISTEN_ADDR=127.0.0.1:18080
export AERA_ADMIN_PUBLIC_URL=http://localhost:18080
export AERA_ADMIN_DATABASE_URL="postgres://aera_admin:aera-admin-dev-only@127.0.0.1:$admin_postgres_port/aera_admin?sslmode=disable"
export AERA_ADMIN_REDIS_ADDR="127.0.0.1:$admin_redis_port"
export AERA_ADMIN_TRUSTED_PROXY_CIDRS='[]'
export AERA_ADMIN_IDENTITY_ENCRYPTION_KEYS="{\"active_key_id\":\"e2e-v1\",\"keys\":{\"e2e-v1\":\"$admin_identity_encryption_key\"}}"
export AERA_ADMIN_IDENTITY_LOOKUP_KEYS="{\"active_key_id\":\"e2e-v1\",\"keys\":{\"e2e-v1\":\"$admin_identity_lookup_key\"}}"
export AERA_ADMIN_TOTP_ENCRYPTION_KEYS="{\"active_key_id\":\"e2e-v1\",\"keys\":{\"e2e-v1\":\"$admin_totp_encryption_key\"}}"
export AERA_ADMIN_SESSION_HMAC_KEY="$admin_session_hmac_key"
export AERA_ADMIN_CSRF_HMAC_KEY="$admin_csrf_hmac_key"
export AERA_ADMIN_OPERATION_HMAC_KEY="$admin_operation_hmac_key"
export AERA_ADMIN_CLOUD_ENABLED=true
export AERA_ADMIN_CLOUD_BASE_URL=https://127.0.0.1:18443
export AERA_ADMIN_CLOUD_CA_FILE="$pki_dir/ca.pem"
export AERA_ADMIN_CLOUD_CLIENT_CERT_FILE="$pki_dir/client.pem"
export AERA_ADMIN_CLOUD_CLIENT_KEY_FILE="$pki_dir/client-key.pem"
export AERA_ADMIN_CLOUD_JWT_SIGNING_KEY_FILE="$pki_dir/service-key.pem"
export AERA_ADMIN_CLOUD_JWT_ISSUER=aera-admin
export AERA_ADMIN_CLOUD_JWT_SUBJECT=aera-admin-e2e
export AERA_ADMIN_CLOUD_SCOPES='["users:read","devices:write","sessions:write","accounts:write","operations:read"]'

set -a
. "$cloud_repo/.env.example"
set +a
export AGENTERA_CLOUD_ENVIRONMENT=test
export AGENTERA_CLOUD_LISTEN_ADDR=127.0.0.1:18086
export AGENTERA_CLOUD_PUBLIC_URL=http://127.0.0.1:18086
export AGENTERA_CLOUD_DATABASE_URL="postgres://aera_cloud:aera-cloud-dev-only@127.0.0.1:$cloud_postgres_port/aera_cloud?sslmode=disable"
export AGENTERA_CLOUD_REDIS_ADDR="127.0.0.1:$cloud_redis_port"
export AGENTERA_CLOUD_IDENTITY_ENCRYPTION_ACTIVE_KEY_ID=cloud-e2e-v1
export AGENTERA_CLOUD_IDENTITY_ENCRYPTION_KEYS="{\"cloud-e2e-v1\":\"$cloud_identity_encryption_key\"}"
export AGENTERA_CLOUD_IDENTITY_LOOKUP_ACTIVE_KEY_ID=cloud-e2e-v1
export AGENTERA_CLOUD_IDENTITY_LOOKUP_KEYS="{\"cloud-e2e-v1\":\"$cloud_identity_lookup_key\"}"
export AGENTERA_CLOUD_INTERNAL_ADMIN_ENABLED=true
export AGENTERA_CLOUD_INTERNAL_ADMIN_LISTEN_ADDR=127.0.0.1:18443
export AGENTERA_CLOUD_INTERNAL_ADMIN_SERVER_CERT_FILE="$pki_dir/cloud.pem"
export AGENTERA_CLOUD_INTERNAL_ADMIN_SERVER_KEY_FILE="$pki_dir/cloud-key.pem"
export AGENTERA_CLOUD_INTERNAL_ADMIN_CLIENT_CA_FILE="$pki_dir/ca.pem"
export AGENTERA_CLOUD_INTERNAL_ADMIN_JWT_PUBLIC_KEY_FILE="$pki_dir/service-public.pem"
export AGENTERA_CLOUD_INTERNAL_ADMIN_JWT_ISSUER=aera-admin
export AGENTERA_CLOUD_INTERNAL_ADMIN_JWT_SUBJECT=aera-admin-e2e
export AGENTERA_CLOUD_INTERNAL_ADMIN_HMAC_ACTIVE_KEY_ID=cloud-admin-e2e-v1
export AGENTERA_CLOUD_INTERNAL_ADMIN_HMAC_KEYS="{\"cloud-admin-e2e-v1\":\"$cloud_internal_hmac_key\"}"

export AERA_ADMIN_E2E_ARTIFACT_DIR="$artifact_dir"
export AERA_ADMIN_E2E_BASE_URL=http://localhost:18080
export AERA_ADMIN_E2E_BOOTSTRAP_BINARY="$bootstrap_binary"
export AERA_ADMIN_E2E_DATABASE_URL="$AERA_ADMIN_DATABASE_URL"
export AERA_ADMIN_E2E_FIXTURE_FILE="$fixture_file"
export AERA_ADMIN_E2E_REPO_ROOT="$repository_root"
export AERA_ADMIN_E2E_SERVER_LOG="$server_log"
export AERA_ADMIN_E2E_CLOUD_LOG="$cloud_log"
export AERA_ADMIN_E2E_CLOUD_FIXTURE_FILE="$cloud_fixture_file"
export AERA_ADMIN_E2E_CLOUD_VERIFY_BINARY="$cloud_e2e_binary"

"$cloud_e2e_binary" seed --output "$cloud_fixture_file"
"$cloud_binary" >"$cloud_log" 2>&1 &
cloud_pid=$!

cloud_ready=false
attempt=0
while [ "$attempt" -lt 80 ]; do
  if printf '' | openssl s_client -tls1_3 -connect 127.0.0.1:18443 -verify_return_error -verify_ip 127.0.0.1 \
      -CAfile "$pki_dir/ca.pem" -cert "$pki_dir/client.pem" -key "$pki_dir/client-key.pem" \
      2>&1 | grep -q 'Verify return code: 0 (ok)'; then
    cloud_ready=true
    break
  fi
  if ! kill -0 "$cloud_pid" 2>/dev/null; then
    echo "Aera Admin E2E Cloud process stopped before mTLS readiness" >&2
    sed -n '1,10p' "$cloud_log" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.25
done
if [ "$cloud_ready" != true ]; then
  echo "Aera Admin E2E Cloud process did not become mTLS-ready" >&2
  exit 1
fi

"$server_binary" >"$server_log" 2>&1 &
server_pid=$!

admin_ready=false
attempt=0
while [ "$attempt" -lt 80 ]; do
  if curl -fsS http://localhost:18080/health/ready >/dev/null 2>&1; then
    admin_ready=true
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "Aera Admin E2E server stopped before readiness" >&2
    sed -n '1,10p' "$server_log" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.25
done
if [ "$admin_ready" != true ]; then
  echo "Aera Admin E2E server did not become ready" >&2
  exit 1
fi

pnpm exec playwright test

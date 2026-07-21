#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
e2e_tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/aera-admin-e2e.XXXXXX")
e2e_tmp_dir=$(CDPATH= cd -- "$e2e_tmp_dir" && pwd -P)
case "$e2e_tmp_dir" in
  */aera-admin-e2e.*) ;;
  *) echo "refusing unsafe E2E temporary directory" >&2; exit 1 ;;
esac
e2e_lock_dir=/tmp/aera-admin-e2e.lock
case "$e2e_lock_dir" in
  */aera-admin-e2e.lock) ;;
  *) rmdir "$e2e_tmp_dir"; echo "refusing unsafe E2E lock directory" >&2; exit 1 ;;
esac
if ! mkdir "$e2e_lock_dir" 2>/dev/null; then
  rmdir "$e2e_tmp_dir"
  echo "another Aera Admin E2E run already owns the fixed test database, Redis namespace, or port" >&2
  exit 1
fi

server_binary="$e2e_tmp_dir/aera-admin"
bootstrap_binary="$e2e_tmp_dir/aera-admin-bootstrap"
cloud_binary="$e2e_tmp_dir/aera-admin-cloud-stub"
fixture_file="$e2e_tmp_dir/fixtures.json"
server_log="$e2e_tmp_dir/server.log"
cloud_log="$e2e_tmp_dir/cloud.log"
pki_dir="$e2e_tmp_dir/pki"
artifact_dir="$e2e_tmp_dir/test-results"
server_pid=""
cloud_pid=""
database_created=false

clear_test_redis() {
  docker compose exec -T redis sh -c '
    redis-cli --scan --pattern "aera-admin:test:*" |
    while IFS= read -r key; do
      if [ -n "$key" ]; then redis-cli UNLINK "$key" >/dev/null; fi
    done
  '
}

drop_test_database() {
  docker compose exec -T postgres psql \
    -v ON_ERROR_STOP=1 -U aera_admin -d postgres \
    -c 'DROP DATABASE IF EXISTS "aera_admin_e2e" WITH (FORCE);' >/dev/null
}

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ -n "$cloud_pid" ]; then
    kill "$cloud_pid" 2>/dev/null || true
    wait "$cloud_pid" 2>/dev/null || true
  fi
  clear_test_redis >/dev/null 2>&1 || true
  if [ "$database_created" = true ]; then drop_test_database >/dev/null 2>&1 || true; fi
  rm -rf -- "$e2e_tmp_dir"
  rmdir "$e2e_lock_dir" 2>/dev/null || true
  exit "$cleanup_status"
}
trap cleanup EXIT INT TERM

cd "$repository_root"
docker compose up -d --wait postgres redis
drop_test_database
docker compose exec -T postgres psql \
  -v ON_ERROR_STOP=1 -U aera_admin -d postgres \
  -c 'CREATE DATABASE "aera_admin_e2e";' >/dev/null
database_created=true
clear_test_redis

pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm --filter @aera/admin-web build
go build -tags release -trimpath -o "$server_binary" ./cmd/aera-admin
go build -trimpath -o "$bootstrap_binary" ./cmd/aera-admin-bootstrap
go build -tags e2e -trimpath -o "$cloud_binary" ./e2e/cloud-stub

mkdir -m 700 "$pki_dir"
openssl req -x509 -newkey rsa:3072 -nodes -days 1 -subj '/CN=Aera Admin E2E CA' \
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

identity_encryption_key=$(openssl rand -base64 32 | tr -d '\n')
identity_lookup_key=$(openssl rand -base64 32 | tr -d '\n')
totp_encryption_key=$(openssl rand -base64 32 | tr -d '\n')
session_hmac_key=$(openssl rand -base64 32 | tr -d '\n')
csrf_hmac_key=$(openssl rand -base64 32 | tr -d '\n')
operation_hmac_key=$(openssl rand -base64 32 | tr -d '\n')

export AERA_ADMIN_ENVIRONMENT=test
export AERA_ADMIN_LISTEN_ADDR=127.0.0.1:18080
export AERA_ADMIN_PUBLIC_URL=http://localhost:18080
export AERA_ADMIN_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin_e2e?sslmode=disable'
export AERA_ADMIN_REDIS_ADDR=127.0.0.1:56382
export AERA_ADMIN_TRUSTED_PROXY_CIDRS='[]'
export AERA_ADMIN_IDENTITY_ENCRYPTION_KEYS="{\"active_key_id\":\"e2e-v1\",\"keys\":{\"e2e-v1\":\"$identity_encryption_key\"}}"
export AERA_ADMIN_IDENTITY_LOOKUP_KEYS="{\"active_key_id\":\"e2e-v1\",\"keys\":{\"e2e-v1\":\"$identity_lookup_key\"}}"
export AERA_ADMIN_TOTP_ENCRYPTION_KEYS="{\"active_key_id\":\"e2e-v1\",\"keys\":{\"e2e-v1\":\"$totp_encryption_key\"}}"
export AERA_ADMIN_SESSION_HMAC_KEY="$session_hmac_key"
export AERA_ADMIN_CSRF_HMAC_KEY="$csrf_hmac_key"
export AERA_ADMIN_OPERATION_HMAC_KEY="$operation_hmac_key"
export AERA_ADMIN_CLOUD_ENABLED=true
export AERA_ADMIN_CLOUD_BASE_URL=https://127.0.0.1:18443
export AERA_ADMIN_CLOUD_CA_FILE="$pki_dir/ca.pem"
export AERA_ADMIN_CLOUD_CLIENT_CERT_FILE="$pki_dir/client.pem"
export AERA_ADMIN_CLOUD_CLIENT_KEY_FILE="$pki_dir/client-key.pem"
export AERA_ADMIN_CLOUD_JWT_SIGNING_KEY_FILE="$pki_dir/service-key.pem"
export AERA_ADMIN_CLOUD_JWT_ISSUER=aera-admin
export AERA_ADMIN_CLOUD_JWT_SUBJECT=aera-admin-e2e
export AERA_ADMIN_CLOUD_SCOPES='["users:read","devices:write","sessions:write","accounts:write","operations:read"]'

export AERA_ADMIN_E2E_ARTIFACT_DIR="$artifact_dir"
export AERA_ADMIN_E2E_BASE_URL=http://localhost:18080
export AERA_ADMIN_E2E_BOOTSTRAP_BINARY="$bootstrap_binary"
export AERA_ADMIN_E2E_DATABASE_URL="$AERA_ADMIN_DATABASE_URL"
export AERA_ADMIN_E2E_FIXTURE_FILE="$fixture_file"
export AERA_ADMIN_E2E_REPO_ROOT="$repository_root"
export AERA_ADMIN_E2E_SERVER_LOG="$server_log"
export AERA_ADMIN_E2E_CLOUD_LOG="$cloud_log"
export AERA_ADMIN_E2E_CLOUD_LISTEN_ADDR=127.0.0.1:18443
export AERA_ADMIN_E2E_CLOUD_CA_FILE="$pki_dir/ca.pem"
export AERA_ADMIN_E2E_CLOUD_CERT_FILE="$pki_dir/cloud.pem"
export AERA_ADMIN_E2E_CLOUD_KEY_FILE="$pki_dir/cloud-key.pem"
export AERA_ADMIN_E2E_CLOUD_JWT_PUBLIC_KEY_FILE="$pki_dir/service-public.pem"

"$cloud_binary" >"$cloud_log" 2>&1 &
cloud_pid=$!

cloud_ready=false
attempt=0
while [ "$attempt" -lt 80 ]; do
  if printf '' | openssl s_client -connect 127.0.0.1:18443 -verify_return_error \
      -CAfile "$pki_dir/ca.pem" -cert "$pki_dir/client.pem" -key "$pki_dir/client-key.pem" \
      2>&1 | grep -q 'Verify return code: 0 (ok)'; then
    cloud_ready=true
    break
  fi
  if ! kill -0 "$cloud_pid" 2>/dev/null; then
    echo "Aera Admin E2E Cloud process stopped before mTLS readiness" >&2
    sed -n '1,5p' "$cloud_log" >&2
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

ready=false
attempt=0
while [ "$attempt" -lt 80 ]; do
  if curl -fsS http://localhost:18080/health/ready >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "Aera Admin E2E server stopped before readiness" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.25
done
if [ "$ready" != true ]; then
  echo "Aera Admin E2E server did not become ready" >&2
  exit 1
fi

pnpm exec playwright test

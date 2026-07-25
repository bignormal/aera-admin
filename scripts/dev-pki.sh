#!/usr/bin/env bash
# 生成本地开发用 PKI，供 agentera-admin BFF 连接 aera-cloud 内部管理 API。
# 产物（deploy/dev-pki/，已 gitignore）：
#   ca.pem / ca-key.pem            开发 CA
#   cloud.pem / cloud-key.pem      aera-cloud 内部管理监听的服务端证书（127.0.0.1 / localhost）
#   client.pem / client-key.pem    BFF 的 mTLS 客户端证书
#   service-key.pem / service-public.pem  Ed25519 服务 JWT 签名密钥对
# 对应 aera-cloud 侧环境变量见 docs/operations/platform-admin-runbook.md。
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
out="${here}/deploy/dev-pki"
mkdir -p "${out}"
cd "${out}"

days=825

if [[ -f ca.pem ]]; then
  echo "dev-pki 已存在于 ${out}，如需重建请先删除该目录。" >&2
  exit 1
fi

umask 077

# 1. 开发 CA（aera-cloud 严格校验：CA:TRUE + keyCertSign）
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout ca-key.pem -out ca.pem -days "${days}" \
  -subj "/CN=agentera-admin dev CA" \
  -addext "basicConstraints = critical, CA:TRUE" \
  -addext "keyUsage = critical, keyCertSign, cRLSign"

# 2. aera-cloud 内部管理服务端证书
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout cloud-key.pem -out cloud.csr \
  -subj "/CN=internal-admin.aera-cloud.dev"
cat > cloud.ext <<'EOF'
basicConstraints = CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, IP:127.0.0.1
EOF
openssl x509 -req -in cloud.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -out cloud.pem -days "${days}" -extfile cloud.ext

# 3. BFF mTLS 客户端证书
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout client-key.pem -out client.csr \
  -subj "/CN=agentera-admin"
cat > client.ext <<'EOF'
basicConstraints = CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = clientAuth
EOF
openssl x509 -req -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -out client.pem -days "${days}" -extfile client.ext

# 4. Ed25519 服务 JWT 密钥对（BFF 私钥签名，aera-cloud 公钥验签）
openssl genpkey -algorithm ed25519 -out service-key.pem
openssl pkey -in service-key.pem -pubout -out service-public.pem

rm -f cloud.csr client.csr cloud.ext client.ext ca.srl

echo "dev-pki 已生成到 ${out}"
echo
echo "agentera-admin (.env):"
echo "  AGENTERA_CLOUD_ADMIN_BASE_URL=https://127.0.0.1:18443"
echo "  AGENTERA_CLOUD_ADMIN_CA_FILE=${out}/ca.pem"
echo "  AGENTERA_CLOUD_ADMIN_CLIENT_CERT_FILE=${out}/client.pem"
echo "  AGENTERA_CLOUD_ADMIN_CLIENT_KEY_FILE=${out}/client-key.pem"
echo "  AGENTERA_CLOUD_ADMIN_JWT_SIGNING_KEY_FILE=${out}/service-key.pem"
echo "  AGENTERA_CLOUD_ADMIN_JWT_ISSUER=agentera-admin"
echo "  AGENTERA_CLOUD_ADMIN_JWT_SUBJECT=agentera-admin-dev"
echo
echo "aera-cloud (环境变量):"
echo "  AGENTERA_CLOUD_INTERNAL_ADMIN_ENABLED=true"
echo "  AGENTERA_CLOUD_INTERNAL_ADMIN_LISTEN_ADDR=127.0.0.1:18443"
echo "  AGENTERA_CLOUD_INTERNAL_ADMIN_SERVER_CERT_FILE=${out}/cloud.pem"
echo "  AGENTERA_CLOUD_INTERNAL_ADMIN_SERVER_KEY_FILE=${out}/cloud-key.pem"
echo "  AGENTERA_CLOUD_INTERNAL_ADMIN_CLIENT_CA_FILE=${out}/ca.pem"
echo "  AGENTERA_CLOUD_INTERNAL_ADMIN_JWT_PUBLIC_KEY_FILE=${out}/service-public.pem"
echo "  AGENTERA_CLOUD_INTERNAL_ADMIN_JWT_ISSUER=agentera-admin"
echo "  AGENTERA_CLOUD_INTERNAL_ADMIN_JWT_SUBJECT=agentera-admin-dev"

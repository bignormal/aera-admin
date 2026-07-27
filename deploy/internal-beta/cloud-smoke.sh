#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'internal beta Admin-to-Cloud smoke failed: %s\n' "$1" >&2
  exit 1
}

container=${AERA_ADMIN_PAYLOAD_CONTAINER:-}
[[ $container =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] ||
  fail 'AERA_ADMIN_PAYLOAD_CONTAINER is invalid'
command -v docker >/dev/null 2>&1 || fail 'docker is required'
docker inspect "$container" >/dev/null 2>&1 ||
  fail 'Admin Payload container is unavailable'

docker exec -i "$container" node <<'NODE'
const { createPrivateKey, randomUUID, sign } = require("node:crypto");
const { readFileSync } = require("node:fs");
const https = require("node:https");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function main() {
  const baseURL = new URL(required("AGENTERA_CLOUD_ADMIN_BASE_URL"));
  if (baseURL.protocol !== "https:" || baseURL.pathname !== "/") {
    throw new Error("Cloud Admin base URL is invalid");
  }
  const scopes = JSON.parse(required("AGENTERA_CLOUD_ADMIN_SCOPES"));
  if (!Array.isArray(scopes) || !scopes.includes("users:read")) {
    throw new Error("Cloud Admin users:read scope is missing");
  }

  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    encode({ alg: "EdDSA", typ: "JWT" }),
    encode({
      aud: "aera-cloud-admin",
      exp: now + 240,
      iat: now,
      iss: required("AGENTERA_CLOUD_ADMIN_JWT_ISSUER"),
      jti: randomUUID(),
      nbf: now - 5,
      scope: scopes,
      sub: required("AGENTERA_CLOUD_ADMIN_JWT_SUBJECT"),
    }),
  ].join(".");
  const privateKey = createPrivateKey(
    readFileSync(required("AGENTERA_CLOUD_ADMIN_JWT_SIGNING_KEY_FILE")),
  );
  const token = `${unsigned}.${sign(null, Buffer.from(unsigned), privateKey).toString("base64url")}`;
  const url = new URL("/internal/admin/v1/health", baseURL);

  const response = await new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        ca: readFileSync(required("AGENTERA_CLOUD_ADMIN_CA_FILE")),
        cert: readFileSync(required("AGENTERA_CLOUD_ADMIN_CLIENT_CERT_FILE")),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "x-request-id": randomUUID(),
        },
        key: readFileSync(required("AGENTERA_CLOUD_ADMIN_CLIENT_KEY_FILE")),
        maxVersion: "TLSv1.3",
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
        servername: url.hostname,
      },
      (incoming) => {
        const chunks = [];
        let size = 0;
        incoming.on("data", (chunk) => {
          size += chunk.length;
          if (size > 4096) {
            request.destroy(new Error("Cloud health response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            statusCode: incoming.statusCode,
          });
        });
      },
    );
    request.setTimeout(5000, () => request.destroy(new Error("Cloud health probe timed out")));
    request.on("error", reject);
    request.end();
  });

  if (response.statusCode !== 200) {
    throw new Error(`Cloud health returned HTTP ${response.statusCode}`);
  }
  const body = JSON.parse(response.body);
  if (body?.status !== "ok" || Object.keys(body).length !== 1) {
    throw new Error("Cloud health response is invalid");
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Cloud health failed"}\n`);
  process.exit(1);
});
NODE

printf 'internal beta Admin-to-Cloud mTLS/JWT smoke passed\n'

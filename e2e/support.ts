import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const roles = ['super_admin', 'developer', 'operator', 'support', 'finance', 'auditor'] as const;
export type Role = (typeof roles)[number];

export interface AdministratorFixture {
  adminId: string;
  email: string;
  password: string;
  recoveryCodes: string[];
  role: Role;
  totpSecret: string;
}

export interface BrowserCandidateFixture {
  activationURL: string;
  adminId: string;
  email: string;
  maskedIdentity: string;
  password: string;
  totpSecret: string;
}

export interface SensitiveCanary {
  kind: string;
  value: string;
}

export interface CloudFixture {
  user_id: string;
  device_id: string;
  session_id: string;
  masked_email: string;
  raw_lookup_identity: string;
  initial_revision: number;
}

export interface E2EFixtures {
  baseURL: string;
  browserCandidate: BrowserCandidateFixture;
  cloud: {
    maskedEmail: string;
    rawLookupIdentity: string;
    sessionID: string;
    deviceID: string;
    userID: string;
  };
  roles: Record<Role, AdministratorFixture[]>;
  sensitiveCanaries: SensitiveCanary[];
}

export interface APIResult<T = unknown> {
  body: T;
  headers: Headers;
  raw: string;
  status: number;
}

export interface AuthenticatedRequest {
  cookie: string;
  csrfToken: string;
  fixture: AdministratorFixture;
}

function fixturePath(): string {
  const value = process.env.AERA_ADMIN_E2E_FIXTURE_FILE;
  if (!value) throw new Error('AERA_ADMIN_E2E_FIXTURE_FILE is required');
  return value;
}

export function readFixtures(): E2EFixtures {
  return JSON.parse(readFileSync(fixturePath(), 'utf8')) as E2EFixtures;
}

export function readCloudFixture(path: string): CloudFixture {
  return JSON.parse(readFileSync(path, 'utf8')) as CloudFixture;
}

export function writeFixtures(fixtures: E2EFixtures): void {
  writeFileSync(fixturePath(), `${JSON.stringify(fixtures, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function appendSensitiveCanaries(canaries: SensitiveCanary[]): void {
  const fixtures = readFixtures();
  const known = new Set(fixtures.sensitiveCanaries.map((item) => `${item.kind}\0${item.value}`));
  for (const canary of canaries) {
    if (!canary.value || known.has(`${canary.kind}\0${canary.value}`)) continue;
    fixtures.sensitiveCanaries.push(canary);
    known.add(`${canary.kind}\0${canary.value}`);
  }
  writeFixtures(fixtures);
}

function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const rawCharacter of value.toUpperCase().replace(/=+$/u, '')) {
    const digit = alphabet.indexOf(rawCharacter);
    if (digit < 0) throw new Error('TOTP secret is not valid base32');
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function generateTOTP(secret: string, stepOffset = 0, now = Date.now()): string {
  const counter = BigInt(Math.floor(now / 30_000) + stepOffset);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

export function activationToken(activationURL: string): string {
  const parsed = new URL(activationURL);
  const token = new URLSearchParams(parsed.hash.slice(1)).get('token');
  if (!token) throw new Error('activation URL does not contain a fragment token');
  return token;
}

export function totpSecretFromURI(provisioningURI: string): string {
  const secret = new URL(provisioningURI).searchParams.get('secret');
  if (!secret) throw new Error('provisioning URI does not contain a TOTP secret');
  return secret;
}

export async function apiRequest<T>(
  baseURL: string,
  path: string,
  options: {
    body?: unknown;
    cookie?: string;
    csrfToken?: string;
    headers?: Record<string, string>;
    method?: string;
    origin?: boolean;
  } = {},
): Promise<APIResult<T>> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const headers = new Headers({ Accept: 'application/json' });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.csrfToken) headers.set('X-CSRF-Token', options.csrfToken);
  if (options.origin ?? (method !== 'GET' && method !== 'HEAD')) headers.set('Origin', baseURL);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  const response = await fetch(`${baseURL}/api/v1${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
    headers,
    method,
    redirect: 'manual',
  });
  const raw = await response.text();
  let body: T;
  try {
    body = (raw === '' ? undefined : JSON.parse(raw)) as T;
  } catch {
    throw new Error(
      `API ${path} returned non-JSON status ${response.status} with Content-Type ${response.headers.get('content-type') ?? 'missing'}`,
    );
  }
  return { body, headers: response.headers, raw, status: response.status };
}

export function expectStatus(result: APIResult, expected: number, operation: string): void {
  if (result.status !== expected) throw new Error(`${operation} returned status ${result.status}, want ${expected}`);
}

function assertAbsent(raw: string, values: string[], operation: string): void {
  if (values.some((value) => value !== '' && raw.includes(value))) {
    throw new Error(`${operation} leaked an inbound credential or identity`);
  }
}

export async function prepareActivation(
  baseURL: string,
  activationURL: string,
  rawEmail: string,
): Promise<{ adminId: string; maskedIdentity: string; secret: string; token: string }> {
  const token = activationToken(activationURL);
  const prepared = await apiRequest<{
    admin_id: string;
    masked_identity: string;
    provisioning_uri: string;
  }>(baseURL, '/auth/activation/prepare', { body: { token } });
  expectStatus(prepared, 200, 'activation preparation');
  assertAbsent(prepared.raw, [token, rawEmail], 'activation preparation');
  return {
    adminId: prepared.body.admin_id,
    maskedIdentity: prepared.body.masked_identity,
    secret: totpSecretFromURI(prepared.body.provisioning_uri),
    token,
  };
}

export async function activateInvitation(
  baseURL: string,
  activationURL: string,
  email: string,
  password: string,
  role: Role,
  canaries: SensitiveCanary[],
): Promise<AdministratorFixture> {
  const prepared = await prepareActivation(baseURL, activationURL, email);
  const code = generateTOTP(prepared.secret);
  const activated = await apiRequest<{ admin_id: string; recovery_codes: string[] }>(baseURL, '/auth/activate', {
    body: { password, token: prepared.token, totp_code: code },
  });
  expectStatus(activated, 200, 'administrator activation');
  assertAbsent(activated.raw, [prepared.token, email, password, code, prepared.secret], 'administrator activation');
  if (!Array.isArray(activated.body.recovery_codes) || activated.body.recovery_codes.length !== 8) {
    throw new Error('administrator activation did not return eight one-time recovery codes');
  }
  canaries.push(
    { kind: 'raw_email', value: email },
    { kind: 'password', value: password },
    { kind: 'activation_token', value: prepared.token },
    { kind: 'totp_secret', value: prepared.secret },
    { kind: 'totp_code', value: code },
    ...activated.body.recovery_codes.map((value) => ({ kind: 'recovery_code', value })),
  );
  return {
    adminId: activated.body.admin_id,
    email,
    password,
    recoveryCodes: activated.body.recovery_codes,
    role,
    totpSecret: prepared.secret,
  };
}

export async function loginWithRecovery(
  baseURL: string,
  fixture: AdministratorFixture,
  recoveryIndex: number,
  canaries?: SensitiveCanary[],
): Promise<AuthenticatedRequest> {
  const begun = await apiRequest<{ challenge_id: string }>(baseURL, '/auth/login', {
    body: { email: fixture.email, password: fixture.password },
  });
  expectStatus(begun, 200, 'password authentication');
  if (begun.headers.has('set-cookie')) throw new Error('password-only authentication created a session cookie');
  assertAbsent(begun.raw, [fixture.email, fixture.password], 'password authentication');
  const recoveryCode = fixture.recoveryCodes[recoveryIndex];
  if (!recoveryCode) throw new Error('requested recovery code is unavailable');
  const completed = await apiRequest<{
    csrf_token: string;
    administrator: { admin_id: string; role: Role };
  }>(baseURL, '/auth/totp/verify', {
    body: { challenge_id: begun.body.challenge_id, recovery_code: recoveryCode, totp_code: '' },
  });
  expectStatus(completed, 200, 'recovery-code authentication');
  assertAbsent(
    completed.raw,
    [fixture.email, fixture.password, begun.body.challenge_id, recoveryCode],
    'recovery-code authentication',
  );
  const setCookie = completed.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';', 1)[0];
  if (!cookie.startsWith('__Host-aera_admin_session=') || !completed.body.csrf_token) {
    throw new Error('completed authentication did not establish the hardened session');
  }
  if (completed.body.administrator.admin_id !== fixture.adminId || completed.body.administrator.role !== fixture.role) {
    throw new Error('completed authentication returned the wrong administrator principal');
  }
  canaries?.push(
    { kind: 'login_challenge', value: begun.body.challenge_id },
    { kind: 'session_token', value: cookie.slice(cookie.indexOf('=') + 1) },
    { kind: 'csrf_token', value: completed.body.csrf_token },
  );
  return { cookie, csrfToken: completed.body.csrf_token, fixture };
}

export function maskedEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${Array.from(local)[0]}***@${domain}`;
}

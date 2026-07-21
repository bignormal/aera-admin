import { expect, test } from '@playwright/test';

import {
  activationToken,
  appendSensitiveCanaries,
  generateTOTP,
  readFixtures,
} from './support';

test('password-only authentication never creates an administrator session', async ({ request }) => {
  const fixtures = readFixtures();
  const administrator = fixtures.roles.super_admin[0];
  const response = await request.post('/api/v1/auth/login', {
    data: { email: administrator.email, password: administrator.password },
    headers: { Origin: fixtures.baseURL },
  });

  expect(response.status()).toBe(200);
  expect(response.headers()['set-cookie']).toBeUndefined();
  const raw = await response.text();
  expect(raw).not.toContain(administrator.email);
  expect(raw).not.toContain(administrator.password);
  expect(JSON.parse(raw)).toEqual(expect.objectContaining({ challenge_id: expect.any(String) }));
});

test('browser activation clears the fragment and never persists activation credentials', async ({ page }) => {
  const fixtures = readFixtures();
  const candidate = fixtures.browserCandidate;
  const token = activationToken(candidate.activationURL);
  const prepareResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/activation/prepare'));

  await page.goto(candidate.activationURL);
  const prepared = await prepareResponse;
  expect(prepared.status()).toBe(200);
  const preparedRaw = await prepared.text();
  expect(preparedRaw).not.toContain(token);
  expect(preparedRaw).not.toContain(candidate.email);
  await expect(page.getByText(candidate.maskedIdentity)).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('');

  const totpCode = generateTOTP(candidate.totpSecret);
  await page.getByLabel('创建独立密码').fill(candidate.password);
  await page.getByLabel('确认密码').fill(candidate.password);
  await page.getByLabel('动态验证码').fill(totpCode);
  const activationResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/activate'));
  await page.getByRole('button', { name: /完成安全激活/ }).click();

  const activated = await activationResponse;
  expect(activated.status()).toBe(200);
  const activatedRaw = await activated.text();
  for (const forbidden of [candidate.email, candidate.password, token, candidate.totpSecret, totpCode]) {
    expect(activatedRaw).not.toContain(forbidden);
  }
  const activatedDocument = JSON.parse(activatedRaw) as { recovery_codes: string[] };
  expect(activatedDocument.recovery_codes).toHaveLength(8);
  await expect(page.getByText(activatedDocument.recovery_codes[0])).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(page.url()).not.toContain(token);
  appendSensitiveCanaries([
    { kind: 'totp_code', value: totpCode },
    ...activatedDocument.recovery_codes.map((value) => ({ kind: 'recovery_code', value })),
  ]);
});

test('mandatory recovery-code MFA establishes only a hardened HttpOnly cookie', async ({ page }) => {
  const fixtures = readFixtures();
  const administrator = fixtures.roles.super_admin[1];
  const recoveryCode = administrator.recoveryCodes[0];

  await page.goto('/login');
  await page.getByLabel('内部邮箱').fill(administrator.email);
  await page.getByLabel('密码').fill(administrator.password);
  await page.getByRole('button', { name: /继\s*续/ }).click();
  await expect(page.getByLabel('动态验证码')).toBeVisible();
  expect(await page.context().cookies()).toEqual([]);

  await page.getByRole('button', { name: '使用恢复码' }).click();
  await page.getByLabel('恢复码').fill(recoveryCode);
  const loginResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/totp/verify'));
  await page.getByRole('button', { name: /安\s*全\s*登\s*录/ }).click();
  const completed = await loginResponse;
  expect(completed.status()).toBe(200);
  const completedRaw = await completed.text();
  for (const forbidden of [administrator.email, administrator.password, recoveryCode]) {
    expect(completedRaw).not.toContain(forbidden);
  }
  const completedDocument = JSON.parse(completedRaw) as { csrf_token: string };

  await expect(page.getByRole('heading', { name: '内部运营工作台' })).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find((cookie) => cookie.name === '__Host-aera_admin_session');
  expect(sessionCookie).toEqual(expect.objectContaining({ httpOnly: true, sameSite: 'Strict', secure: true }));
  expect(sessionCookie?.value).toBeTruthy();
  appendSensitiveCanaries([
    { kind: 'session_token', value: sessionCookie?.value ?? '' },
    { kind: 'csrf_token', value: completedDocument.csrf_token },
  ]);

  await page.reload();
  await expect(page.getByRole('heading', { name: '内部运营工作台' })).toBeVisible();
});

test('HTML, API, health, and not-found responses carry the security policy', async ({ request }) => {
  const fixtures = readFixtures();
  for (const path of ['/login', '/api/v1/me', '/health/live', '/health/missing']) {
    const response = await request.get(path);
    const headers = response.headers();
    expect(headers['content-security-policy']).toBe(
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:",
    );
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['permissions-policy']).toBe('camera=(), geolocation=(), microphone=(), payment=(), usb=()');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['strict-transport-security']).toBeUndefined();
    expect((await response.text()).toLowerCase()).not.toContain(fixtures.roles.super_admin[0].email);
  }
});

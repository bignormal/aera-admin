import { generateSecret, generateURI, verifySync } from 'otplib'
import type { PayloadRequest } from 'payload'

import { openSecret, sealSecret } from './secret-box'

// 高危操作二次验证窗口：通过 TOTP 校验后 5 分钟内有效，
// 语义对齐旧 aera-admin 的 recentTOTP 中间件。
export const stepUpWindowSeconds = 5 * 60
const totpIssuer = 'Aera Admin'

export type StepUpState = {
  stepUpVerifiedAt?: string
  totpEnabled: boolean
  windowSeconds: number
}

type AdminSecurityDocument = {
  email?: unknown
  id: number | string
  stepUpVerifiedAt?: unknown
  totpEnabledAt?: unknown
  totpSecret?: unknown
}

async function loadAdminSecurity(req: PayloadRequest): Promise<AdminSecurityDocument | undefined> {
  if (!req.user) return undefined
  try {
    const doc = await req.payload.findByID({
      collection: 'admins',
      depth: 0,
      id: req.user.id,
      overrideAccess: true,
      showHiddenFields: true,
    })
    return doc as AdminSecurityDocument
  } catch {
    return undefined
  }
}

function verifyCode(sealedSecret: unknown, code: string): boolean {
  if (typeof sealedSecret !== 'string' || !/^\d{6}$/.test(code)) return false
  const secret = openSecret(sealedSecret)
  if (!secret) return false
  try {
    return verifySync({ secret, token: code }).valid
  } catch {
    return false
  }
}

export type EnrollResult =
  | { otpauthURL: string; secret: string; status: 'pending' }
  | { errorCode: 'TOTP_ALREADY_ENABLED' | 'UNAUTHENTICATED'; status: 'rejected' }

export async function enrollTOTP(req: PayloadRequest): Promise<EnrollResult> {
  const admin = await loadAdminSecurity(req)
  if (!admin) return { errorCode: 'UNAUTHENTICATED', status: 'rejected' }
  if (admin.totpEnabledAt) return { errorCode: 'TOTP_ALREADY_ENABLED', status: 'rejected' }

  const secret = generateSecret()
  await req.payload.update({
    collection: 'admins',
    data: { totpEnabledAt: null, totpSecret: sealSecret(secret) },
    id: admin.id,
    overrideAccess: true,
    req,
  })
  const account = typeof admin.email === 'string' ? admin.email : String(admin.id)
  return {
    otpauthURL: generateURI({ issuer: totpIssuer, label: account, secret }),
    secret,
    status: 'pending',
  }
}

export type ConfirmResult =
  | { status: 'enabled'; totpEnabledAt: string }
  | {
      errorCode: 'INVALID_CODE' | 'TOTP_ALREADY_ENABLED' | 'TOTP_NOT_ENROLLED' | 'UNAUTHENTICATED'
      status: 'rejected'
    }

export async function confirmTOTP(req: PayloadRequest, code: string): Promise<ConfirmResult> {
  const admin = await loadAdminSecurity(req)
  if (!admin) return { errorCode: 'UNAUTHENTICATED', status: 'rejected' }
  if (admin.totpEnabledAt) return { errorCode: 'TOTP_ALREADY_ENABLED', status: 'rejected' }
  if (typeof admin.totpSecret !== 'string' || !admin.totpSecret) {
    return { errorCode: 'TOTP_NOT_ENROLLED', status: 'rejected' }
  }
  if (!verifyCode(admin.totpSecret, code)) return { errorCode: 'INVALID_CODE', status: 'rejected' }

  const totpEnabledAt = new Date().toISOString()
  await req.payload.update({
    collection: 'admins',
    data: { totpEnabledAt },
    id: admin.id,
    overrideAccess: true,
    req,
  })
  return { status: 'enabled', totpEnabledAt }
}

export type StepUpResult =
  | { expiresInSeconds: number; status: 'verified'; verifiedAt: string }
  | {
      errorCode: 'INVALID_CODE' | 'TOTP_NOT_ENROLLED' | 'UNAUTHENTICATED'
      status: 'rejected'
    }

export async function verifyStepUp(req: PayloadRequest, code: string): Promise<StepUpResult> {
  const admin = await loadAdminSecurity(req)
  if (!admin) return { errorCode: 'UNAUTHENTICATED', status: 'rejected' }
  if (!admin.totpEnabledAt || typeof admin.totpSecret !== 'string' || !admin.totpSecret) {
    return { errorCode: 'TOTP_NOT_ENROLLED', status: 'rejected' }
  }
  if (!verifyCode(admin.totpSecret, code)) return { errorCode: 'INVALID_CODE', status: 'rejected' }

  const verifiedAt = new Date().toISOString()
  await req.payload.update({
    collection: 'admins',
    data: { stepUpVerifiedAt: verifiedAt },
    id: admin.id,
    overrideAccess: true,
    req,
  })
  return { expiresInSeconds: stepUpWindowSeconds, status: 'verified', verifiedAt }
}

export async function stepUpState(req: PayloadRequest): Promise<StepUpState | undefined> {
  const admin = await loadAdminSecurity(req)
  if (!admin) return undefined
  const verifiedAt = typeof admin.stepUpVerifiedAt === 'string' ? admin.stepUpVerifiedAt : undefined
  return {
    stepUpVerifiedAt: verifiedAt,
    totpEnabled: Boolean(admin.totpEnabledAt),
    windowSeconds: stepUpWindowSeconds,
  }
}

export type StepUpAssertion =
  | { ok: true }
  | { errorCode: 'STEP_UP_REQUIRED' | 'TOTP_NOT_ENROLLED'; ok: false }

// requiresReauthentication 操作放行前的强制校验：
// 未绑定 TOTP → TOTP_NOT_ENROLLED；超窗或未验证 → STEP_UP_REQUIRED。
export async function assertRecentStepUp(
  req: PayloadRequest,
  now: () => Date = () => new Date(),
): Promise<StepUpAssertion> {
  const admin = await loadAdminSecurity(req)
  if (!admin || !admin.totpEnabledAt) return { errorCode: 'TOTP_NOT_ENROLLED', ok: false }
  const verifiedAt =
    typeof admin.stepUpVerifiedAt === 'string' ? Date.parse(admin.stepUpVerifiedAt) : Number.NaN
  if (!Number.isFinite(verifiedAt)) return { errorCode: 'STEP_UP_REQUIRED', ok: false }
  const elapsedSeconds = (now().getTime() - verifiedAt) / 1000
  if (elapsedSeconds < 0 || elapsedSeconds > stepUpWindowSeconds) {
    return { errorCode: 'STEP_UP_REQUIRED', ok: false }
  }
  return { ok: true }
}

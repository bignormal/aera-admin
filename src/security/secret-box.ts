import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// TOTP 秘钥等敏感字段的对称加密盒：AES-256-GCM，
// 密钥由 PAYLOAD_SECRET 经 SHA-256 派生，密文格式 v1:iv:tag:data（base64url）。
const version = 'v1'

function encryptionKey(): Buffer {
  const secret = process.env.PAYLOAD_SECRET
  if (!secret) throw new Error('PAYLOAD_SECRET is required for secret encryption')
  return createHash('sha256').update(secret).digest()
}

export function sealSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    version,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':')
}

export function openSecret(sealed: string): string | undefined {
  const parts = sealed.split(':')
  if (parts.length !== 4 || parts[0] !== version) return undefined
  try {
    const iv = Buffer.from(parts[1], 'base64url')
    const tag = Buffer.from(parts[2], 'base64url')
    const data = Buffer.from(parts[3], 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

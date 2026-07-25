import { getPayload } from 'payload'
import config from '../../src/payload.config.js'

export const testUser = {
  active: true,
  displayName: '测试管理员',
  email: 'admin@agentera.local',
  password: 'agentera-test-password',
  role: 'super_admin' as const,
}

export const publisherUser = {
  active: true,
  displayName: '测试发布员',
  email: 'publisher@agentera.local',
  password: 'agentera-publisher-password',
  role: 'publisher' as const,
}

export const operationsUser = {
  active: true,
  displayName: '测试运营管理员',
  email: 'operations@agentera.local',
  password: 'agentera-operations-password',
  role: 'operations_admin' as const,
}

export const financeUser = {
  active: true,
  displayName: '测试财务管理员',
  email: 'finance@agentera.local',
  password: 'agentera-finance-password',
  role: 'finance_admin' as const,
}

export const auditorUser = {
  active: true,
  displayName: '测试审计观察员',
  email: 'auditor@agentera.local',
  password: 'agentera-auditor-password',
  role: 'auditor' as const,
}

/**
 * Seeds a test user for e2e admin tests.
 */
export async function seedTestUser(): Promise<void> {
  const payload = await getPayload({ config })

  // Delete existing test user if any
  await payload.delete({
    collection: 'admins',
    overrideAccess: true,
    where: {
      email: {
        equals: testUser.email,
      },
    },
  })

  // Create fresh test user
  await payload.create({
    collection: 'admins',
    data: testUser,
    overrideAccess: true,
  })
}

/**
 * Cleans up test user after tests
 */
export async function cleanupTestUser(): Promise<void> {
  const payload = await getPayload({ config })

  await payload.delete({
    collection: 'admins',
    overrideAccess: true,
    where: {
      email: {
        equals: testUser.email,
      },
    },
  })
}

export async function seedPublisherUser(): Promise<void> {
  const payload = await getPayload({ config })

  await payload.delete({
    collection: 'admins',
    overrideAccess: true,
    where: { email: { equals: publisherUser.email } },
  })

  await payload.create({
    collection: 'admins',
    data: publisherUser,
    overrideAccess: true,
  })
}

export async function cleanupPublisherUser(): Promise<void> {
  const payload = await getPayload({ config })

  await payload.delete({
    collection: 'admins',
    overrideAccess: true,
    where: { email: { equals: publisherUser.email } },
  })
}

export async function seedAuditorUser(): Promise<void> {
  const payload = await getPayload({ config })

  await payload.delete({
    collection: 'admins',
    overrideAccess: true,
    where: { email: { equals: auditorUser.email } },
  })

  await payload.create({
    collection: 'admins',
    data: auditorUser,
    overrideAccess: true,
  })
}

export async function cleanupAuditorUser(): Promise<void> {
  const payload = await getPayload({ config })

  await payload.delete({
    collection: 'admins',
    overrideAccess: true,
    where: { email: { equals: auditorUser.email } },
  })
}

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repositoryRoot, 'scripts/sync-cloud-admin-contract.mjs')
const mirrorPath = path.join(repositoryRoot, 'api/openapi/cloud-admin-client.yaml')
const generatedPaths = [
  path.join(repositoryRoot, 'src/platform-api/cloud/generated.ts'),
  path.join(repositoryRoot, 'admin-web/src/service/generated/cloud-admin.ts'),
]

function temporarySource(bytes) {
  const root = mkdtempSync(path.join(tmpdir(), 'aera-cloud-admin-contract-'))
  const directory = path.join(root, 'api/openapi')
  mkdirSync(directory, { recursive: true })
  const sourcePath = path.join(directory, 'internal-admin.yaml')
  writeFileSync(sourcePath, bytes)
  return sourcePath
}

test('accepts the exact Cloud source bytes in check mode', () => {
  const sourcePath = temporarySource(readFileSync(mirrorPath))
  execFileSync(process.execPath, [scriptPath, '--check', '--source', sourcePath], {
    cwd: repositoryRoot,
    stdio: 'pipe',
  })
})

test('rejects a Cloud source whose bytes drift from the controlled mirror', () => {
  const sourcePath = temporarySource(
    Buffer.concat([readFileSync(mirrorPath), Buffer.from('\n# drift\n')]),
  )
  const result = spawnSync(process.execPath, [scriptPath, '--check', '--source', sourcePath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Cloud Internal Admin contract drift detected: source bytes/)
})

test('rejects a source outside api/openapi/internal-admin.yaml', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--check', '--source', mirrorPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must be a separate api\/openapi\/internal-admin.yaml/)
})

test('publishes the fixed Desktop Fleet Internal Admin operations', () => {
  const mirror = readFileSync(mirrorPath, 'utf8')
  for (const route of [
    '/internal/admin/v1/desktop-control/instances:',
    '/internal/admin/v1/users/{userID}/desktop-control/instances:',
    '/internal/admin/v1/desktop-control/instances/{deviceID}:',
    '/internal/admin/v1/desktop-control/instances/{deviceID}/health-check:',
    '/internal/admin/v1/desktop-control/commands/{commandID}:',
  ]) {
    assert.match(mirror, new RegExp(route.replace(/[{}]/g, '\\$&')))
  }
  for (const generatedPath of generatedPaths) {
    const generated = readFileSync(generatedPath, 'utf8')
    for (const operation of [
      'listDesktopControlInstances',
      'listUserDesktopControlInstances',
      'getDesktopControlInstance',
      'createDesktopHealthCheck',
      'getDesktopControlCommand',
    ]) {
      assert.match(generated, new RegExp(operation))
    }
  }
})

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

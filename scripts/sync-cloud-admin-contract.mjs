#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mirrorPath = path.join(repositoryRoot, 'api/openapi/cloud-admin-client.yaml')
const generatedPaths = [
  path.join(repositoryRoot, 'src/platform-api/cloud/generated.ts'),
  path.join(repositoryRoot, 'admin-web/src/service/generated/cloud-admin.ts'),
]
const generatorPath = path.join(repositoryRoot, 'node_modules/.bin/openapi-typescript')

function parseArguments(argv) {
  const options = { check: false, source: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--check') {
      options.check = true
      continue
    }
    if (argument === '--source') {
      options.source = argv[index + 1]
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.check && !options.source) {
    throw new Error('Write mode requires --source <cloud-repo>/api/openapi/internal-admin.yaml')
  }
  return options
}

function validateSourcePath(sourcePath) {
  const resolved = path.resolve(sourcePath)
  const openapiDirectory = path.dirname(resolved)
  const apiDirectory = path.dirname(openapiDirectory)
  if (
    path.basename(resolved) !== 'internal-admin.yaml' ||
    path.basename(openapiDirectory) !== 'openapi' ||
    path.basename(apiDirectory) !== 'api' ||
    resolved === mirrorPath
  ) {
    throw new Error('Cloud contract source must be a separate api/openapi/internal-admin.yaml')
  }
  if (!existsSync(resolved)) throw new Error(`Cloud contract source does not exist: ${resolved}`)
  return resolved
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function generateTypes(schemaPath, digest) {
  if (!existsSync(generatorPath)) {
    throw new Error('openapi-typescript is not installed; run pnpm install --frozen-lockfile')
  }
  const generated = execFileSync(
    generatorPath,
    [schemaPath, '--alphabetize', '--export-type', '--immutable'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  return [
    '// Generated from the Cloud Internal Admin OpenAPI. Do not edit by hand.',
    `// Cloud Internal Admin source sha256: ${digest}`,
    generated.trimEnd(),
    '',
  ].join('\n')
}

function expectedGeneratedOutputs(schemaPath, digest) {
  return generatedPaths.map(() => generateTypes(schemaPath, digest))
}

function assertCurrent(sourcePath) {
  if (!existsSync(mirrorPath)) {
    throw new Error('Cloud Internal Admin contract drift detected: controlled mirror is missing')
  }
  const mirror = readFileSync(mirrorPath)
  const drift = []
  if (sourcePath && !readFileSync(sourcePath).equals(mirror)) drift.push('source bytes')
  const digest = sha256(mirror)
  const expectedOutputs = expectedGeneratedOutputs(mirrorPath, digest)
  for (const [index, outputPath] of generatedPaths.entries()) {
    if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== expectedOutputs[index]) {
      drift.push(path.relative(repositoryRoot, outputPath))
    }
  }
  if (drift.length > 0) {
    throw new Error(`Cloud Internal Admin contract drift detected: ${drift.join(', ')}`)
  }
  process.stdout.write(`Cloud Internal Admin contract verified (${digest})\n`)
}

function synchronize(sourcePath) {
  const source = readFileSync(sourcePath)
  mkdirSync(path.dirname(mirrorPath), { recursive: true })
  writeFileSync(mirrorPath, source)
  const digest = sha256(source)
  const outputs = expectedGeneratedOutputs(mirrorPath, digest)
  for (const [index, outputPath] of generatedPaths.entries()) {
    mkdirSync(path.dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, outputs[index])
  }
  process.stdout.write(`Cloud Internal Admin contract synchronized (${digest})\n`)
}

const options = parseArguments(process.argv.slice(2))
const sourcePath = options.source ? validateSourcePath(options.source) : undefined
if (options.check) assertCurrent(sourcePath)
else synchronize(sourcePath)

// Run after build:electron; exercises the actual isolated native settings reader.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { prepareClaudePermissionObserver } from '../dist-electron/providers/claude/permission-observer.js'

const root = await mkdtemp(join(tmpdir(), 'mako-claude-permission-settings-'))
const configRoot = join(root, 'claude-config')
await mkdir(configRoot)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_') && !key.includes('TELEMETRY') && !key.startsWith('ANT_OTEL_') && !key.startsWith('CLAUDE_CODE_OTEL_') && !['BETA_TRACING_ENDPOINT', 'DO_NOT_TRACK'].includes(key)))
env.CLAUDE_CONFIG_DIR = configRoot
let observer
try {
  const config = { cwd: root, env: { ...env }, settingSources: ['user'] }
  const start = performance.now()
  observer = await prepareClaudePermissionObserver({ root, config, sessionId: randomUUID(), previous: [], publish() {} })
  assert.ok(observer, 'Unconfigured bundled runtime must receive the local observer')
  assert.match(config.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, /^http:\/\/127\.0\.0\.1:/)
  await observer.dispose()
  console.log(`Unconfigured native settings and receiver setup: ${(performance.now() - start).toFixed(1)} ms`)
  for (const settings of [
    { env: { OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://existing.example.test' } },
    { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '0' } },
    { otelHeadersHelper: 'must-not-execute' },
  ]) {
    await writeFile(join(configRoot, 'settings.json'), JSON.stringify(settings))
    const config = { cwd: root, env: { ...env }, settingSources: ['user'] }
    const before = structuredClone(config)
    assert.equal(await prepareClaudePermissionObserver({ root, config, sessionId: randomUUID(), previous: [], publish() {} }), undefined)
    assert.deepEqual(config, before, 'Native user telemetry, opt-outs and headers helpers stay unchanged')
  }
  console.log('PASS actual native settings reader: account-scoped configuration, destination, opt-out and helper preservation')
} finally { await observer?.dispose(); await rm(root, { recursive: true, force: true }) }

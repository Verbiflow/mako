// Run after build:electron; exercises the actual isolated native settings reader.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { prepareClaudePermissionObserver } from '@mako/host/harnesses/claude/permission-observer'
import { ClaudeSettingsReader } from '@mako/host/harnesses/claude/approval-settings'

const root = await mkdtemp(join(tmpdir(), 'mako-claude-permission-settings-'))
const configRoot = join(root, 'claude-config')
await mkdir(configRoot)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OTEL_') && !key.includes('TELEMETRY') && !key.startsWith('ANT_OTEL_') && !key.startsWith('CLAUDE_CODE_OTEL_') && !['BETA_TRACING_ENDPOINT', 'DO_NOT_TRACK'].includes(key)))
env.CLAUDE_CONFIG_DIR = configRoot
let observer
// One reader for the run, as a driver keeps one: its worker loads the SDK once and takes each check's environment.
const settings = new ClaudeSettingsReader()
try {
  const config = { cwd: root, env: { ...env }, settingSources: ['user'] }
  const start = performance.now()
  observer = await prepareClaudePermissionObserver({ root, settings, config, sessionId: randomUUID(), previous: [], publish() {} })
  assert.ok(observer, 'Unconfigured bundled runtime must receive the local observer')
  assert.match(config.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, /^http:\/\/127\.0\.0\.1:/)
  await observer.dispose()
  console.log(`Unconfigured native settings and receiver setup: ${(performance.now() - start).toFixed(1)} ms`)
  for (const stored of [
    { env: { OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://existing.example.test' } },
    { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '0' } },
    { otelHeadersHelper: 'must-not-execute' },
  ]) {
    await writeFile(join(configRoot, 'settings.json'), JSON.stringify(stored))
    const config = { cwd: root, env: { ...env }, settingSources: ['user'] }
    const before = structuredClone(config)
    const sessionId = randomUUID(), previous = { scope: randomUUID(), sessionId, requestId: 'answered-tool' }
    const known = await prepareClaudePermissionObserver({ root, settings, config, sessionId, previous: [previous], publish() {} })
    assert.equal(known.identify('new-tool'), undefined, 'Configured monitoring creates no new event-observation claim')
    assert.deepEqual(known.identify('answered-tool'), previous, 'Changing monitoring cannot resurrect an answered callback')
    await known.dispose()
    assert.deepEqual(config, before, 'Native user telemetry, opt-outs and headers helpers stay unchanged')
  }
  // The kept worker reads each check under its own account and sees a settings file changed between checks.
  const other = join(root, 'other-config')
  await mkdir(other)
  await writeFile(join(configRoot, 'settings.json'), JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'otlp' } }))
  const check = (dir) => settings.compatible({ cwd: root, env: { ...env, CLAUDE_CONFIG_DIR: dir }, settingSources: ['user'] })
  assert.equal(await check(configRoot), false, 'the account whose settings set telemetry')
  assert.equal(await check(other), true, 'the next check, another account, reads its own')
  assert.equal(await check(configRoot), false, 'and back')
  await writeFile(join(configRoot, 'settings.json'), JSON.stringify({ model: 'fixture' }))
  assert.equal(await check(configRoot), true, 'a settings file changed since is read as it is now')
  const warm = performance.now()
  for (let i = 0; i < 20; i++) await check(other)
  const each = (performance.now() - warm) / 20
  assert.ok(each < 50, `a check on the kept worker takes ${each.toFixed(1)} ms`)
  console.log(`Kept settings worker: ${each.toFixed(1)} ms a check`)
  console.log('PASS actual native settings reader: account-scoped configuration, destination, opt-out and helper preservation; one kept worker across accounts and edits')
} finally { settings.close(); await observer?.dispose(); await rm(root, { recursive: true, force: true }) }

// Real Electron host + catalog worker; submit capture synchronously with installation.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.versions.electron) {
  const source = process.argv[2]
  assert.ok(source, 'Supply a disposable native Codex history containing an unanswered question')
  const root = await mkdtemp(join(tmpdir(), 'mako-catalog-capture-'))
  const store = join(root, 'home/.codex/sessions/2026/09/24')
  await mkdir(store, { recursive: true })
  await copyFile(source, join(store, 'rollout-fixture.jsonl'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, HOME: join(root, 'home'), MAKO_CATALOG_CAPTURE_ROOT: root, MAKO_RELAY: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve('node_modules/.bin/electron'), [root], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 120_000)
  child.once('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1 })
} else {
  void run()
}

async function run() {
  const { app } = await import('electron')
  const root = process.env.MAKO_CATALOG_CAPTURE_ROOT
  app.setPath('userData', join(root, 'profile'))
  await app.whenReady()
  const threads = await import('../dist-electron/threads.js')
  const { LiveConversations } = await import('../dist-electron/live-conversations.js')
  const { providerHost } = await import('../dist-electron/providers/index.js')
  const owner = new LiveConversations({ root: join(root, 'conversations'), appPath: app.getAppPath(), driver: id => providerHost.liveDrivers.get(id), history: threads.pageThread, emit: () => {} })
  const report = { root, outcome: 'running', events: [] }
  try {
    const source = join(root, 'home/.codex/sessions/2026/09/24/rollout-fixture.jsonl')
    threads.installThreads(event => { if (event.type === 'notice') report.events.push(event) })
    report.readyAtCapture = threads.threadsReady()
    assert.equal(report.readyAtCapture, false)
    const started = performance.now()
    const captured = await owner.capture(randomUUID(), source)
    report.elapsedMs = Math.round(performance.now() - started)
    report.discoveryReadyAfterCapture = threads.threadsReady()
    assert.ok(captured.base.entries.length > 0)
    assert.ok(captured.control.questions.some(q => q.native.questions.some(item => !q.answered?.includes(item.id))))
    report.nativeId = captured.session.nativeId
    report.entries = captured.base.entries.length
    report.questions = captured.control.questions.length
    report.outcome = 'passed'
    console.log(JSON.stringify(report))
  } catch (error) {
    report.outcome = 'failed'
    report.error = String(error.stack ?? error)
    console.error(error)
    process.exitCode = 1
  } finally {
    owner.stop()
    threads.stopThreads()
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2))
    console.log(`Catalog capture evidence: ${root}/result.json`)
    app.exit(process.exitCode ?? 0)
  }
}

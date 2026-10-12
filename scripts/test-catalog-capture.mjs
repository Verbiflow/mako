// The host's catalog and its worker, in a host process on a throwaway home;
// submit capture synchronously with installation. The home is too deep for
// the shared reader's socket, so the host reads through its own worker.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeStores } from '@mako/sessions/read-only-sqlite'

const nativeStores = new NativeStores(false)

if (!process.env.MAKO_CATALOG_CAPTURE_ROOT) {
  const source = process.argv[2]
  assert.ok(source, 'Supply a disposable native Codex history containing an unanswered question')
  const root = await mkdtemp(join(tmpdir(), 'mako-catalog-capture-'))
  const store = join(root, 'home/.codex/sessions/2026/09/24')
  await mkdir(store, { recursive: true })
  await copyFile(source, join(store, 'rollout-fixture.jsonl'))
  const env = { ...process.env, HOME: join(root, 'home'), MAKO_DATA_ROOT: join(root, 'profile'), MAKO_CATALOG_CAPTURE_ROOT: root }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 120_000)
  child.once('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1 })
} else {
  void run()
}

async function run() {
  const root = process.env.MAKO_CATALOG_CAPTURE_ROOT
  const { threadCatalog } = await import('@mako/host/threads/catalog')
  const { defaultCatalogIdentity, loadedCatalogCode } = await import('@mako/sessions')
  const { HostJobs } = await import('@mako/host/base/host-jobs')
  const { WorktreeOrigins } = await import('@mako/host/threads/worktree-origins')
  const { Lineage } = await import('@mako/host/threads/lineage')
  const { threadHarnesses } = await import('@mako/host/harnesses/thread-harnesses')
  const { ConversationFiles } = await import('@mako/host/workspaces/files')
  const { Git } = await import('@mako/git')
  const { ArtifactPreviews } = await import('@mako/host/workspaces/artifact-previews')
  const { createHarnessHost, detachedHarnessContext } = await import('@mako/host/harnesses/harness-host')
  const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))
  const { processHostEnvironment } = await import('@mako/host/base/host-environment')
  const environment = processHostEnvironment()
  const report = { root, outcome: 'running', events: [] }
  const git = new Git()
  const files = new ConversationFiles(git, new ArtifactPreviews(() => providerHost.artifactPreviews.list()))
  const threads = threadCatalog({
    dataRoot: environment.dataRoot,
    app: environment,
    sessionMemory: null,
    threadStore: null,
    worktreeOrigins: new WorktreeOrigins(join(root, 'worktree-origins.json')),
    lineage: new Lineage(join(root, 'lineage.json')),
    harnesses: threadHarnesses(providerHost),
    readFile: (cwd, path, dataDir) => files.read(cwd, path, dataDir),
    catalogIdentity: () => defaultCatalogIdentity(join(root, 'home/.mako/archive'), loadedCatalogCode()),
    jobs: new HostJobs(),
    readOnly: false,
    emit: event => { if (event.type === 'notice') report.events.push(event) },
  })
  const { LiveConversations } = await import('@mako/host/conversations/live-conversations')
  const owner = new LiveConversations({ root: join(root, 'conversations'), appPath: resolve('.'), driver: id => providerHost.liveDrivers.get(id), history: threads.page, emit: () => {} })
  try {
    const source = join(root, 'home/.codex/sessions/2026/09/24/rollout-fixture.jsonl')
    threads.start()
    report.readyAtCapture = threads.ready()
    assert.equal(report.readyAtCapture, false)
    const started = performance.now()
    const captured = await owner.capture(randomUUID(), source)
    report.elapsedMs = Math.round(performance.now() - started)
    report.discoveryReadyAfterCapture = threads.ready()
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
    threads.stop()
    git.close()
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2))
    console.log(`Catalog capture evidence: ${root}/result.json`)
  }
}

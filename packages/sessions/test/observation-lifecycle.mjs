import assert from 'node:assert/strict'
import { mkdtemp, writeFile, appendFile, readFile, stat, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionCatalog } from '../dist/catalog.js'
const root = await mkdtemp(join(tmpdir(), 'mako-observation-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  const deadline = Date.now() + 2000
  while (!check()) { assert.ok(Date.now() < deadline, 'delivery within two seconds'); await sleep(10) }
}
const catalogs = []
try {
  for (const harness of ['claude', 'codex', 'cursor', 'grok', 'devin', 'opencode']) {
    const source = join(root, `${harness}.db`), sidecar = `${source}-wal`
    const shared = ['devin', 'opencode'].includes(harness)
    const path = shared ? `${source}#session` : source
    await writeFile(source, 'first\n')
    let reads = 0, discovers = 0
    const provider = {
      harness, displayName: harness, roots: () => [root],
      observationPaths: () => [source, sidecar], rescanRoot: () => shared,
      discover: async () => { discovers++; const info = await stat(source); return [{ path, bytes: info.size, mtimeMs: info.mtimeMs }] },
      stat: async () => { const info = await stat(source); return { path, bytes: info.size, mtimeMs: info.mtimeMs } },
      peek: async file => ({ harness, nativeId: 'session', title: 'test', model: 'test', ...file }),
      read: async () => { reads++; return { ref: { harness, nativeId: 'session', path }, entries: (await readFile(source, 'utf8')).trim().split('\n').map(text => ({ kind: 'user', text })) } },
    }
    const catalog = new SessionCatalog([provider]); catalogs.push(catalog)
    await catalog.scan()
    const updates = [], secondUpdates = []
    const first = catalog.follow(path, 0, entries => updates.push(entries))
    catalog.startWatching()
    // Silence directory events to prove independence from FSEvents health.
    for (const watcher of catalog.watchers.values()) watcher.close()
    catalog.startWatching()
    const second = catalog.follow(path, 0, entries => secondUpdates.push(entries))
    assert.equal(catalog.observations.size, 2, 'viewers share source checks')
    const start = performance.now()
    await appendFile(source, 'second\n')
    await until(() => updates.some(entries => entries.at(-1)?.text === 'second'))
    assert.equal(secondUpdates.at(-1)?.at(-1)?.text, 'second')
    const latency = performance.now() - start
    first()
    assert.equal(catalog.observations.size, 2)
    await writeFile(`${source}.next`, 'replacement\n')
    await rename(`${source}.next`, source)
    await until(() => secondUpdates.at(-1)?.at(-1)?.text === 'replacement')
    const beforeSidecar = discovers
    await writeFile(sidecar, 'checkpoint')
    if (shared) await until(() => discovers > beforeSidecar)
    await sleep(700)
    const idleReads = reads, idleDiscovers = discovers
    await sleep(1100)
    assert.equal(reads, idleReads, 'unchanged sources are not parsed')
    assert.equal(discovers, idleDiscovers, 'unchanged sources do not rescan')
    second()
    assert.equal(catalog.observations.size, 0, 'last viewer releases source checks')
    await catalog.stop()
    const final = secondUpdates.length
    await appendFile(source, 'after stop\n')
    await sleep(550)
    assert.equal(secondUpdates.length, final)
    console.log(`${harness}: append ${latency.toFixed(1)} ms; replacement, late WAL, subscription sharing, idle parsing, cleanup pass`)
  }
  const path = join(root, 'blocked')
  await writeFile(path, 'initial')
  let unblock, entered = false, closed = false, delivered = false
  const blocked = new Promise(resolve => { unblock = resolve })
  const provider = {
    harness: 'test', displayName: 'Test', roots: () => [root], discover: async () => [],
    peek: async () => { entered = true; await blocked; assert.equal(closed, false); return { harness: 'test', nativeId: 'test', path } },
    read: async () => ({ ref: { harness: 'test', nativeId: 'test', path }, entries: [{ kind: 'user', text: 'late' }] }),
    close: () => { closed = true },
  }
  const catalog = new SessionCatalog([provider]); catalogs.push(catalog)
  catalog.follow(path, 0, () => { delivered = true })
  const refresh = catalog.refresh(provider, path)
  await until(() => entered)
  const stopping = catalog.stop()
  assert.equal(closed, false)
  unblock()
  await Promise.all([refresh, stopping])
  assert.equal(delivered, false)
  assert.equal(closed, true)
  console.log('Stop drains in-flight refresh before closing provider; no late callbacks')
  for (const operation of ['scan', 'reconcile']) {
    let release, started = false, closed = false
    const gate = new Promise(resolve => { release = resolve })
    const file = { path, bytes: 7, mtimeMs: 1 }
    const provider = {
      harness: 'test', displayName: 'Test', roots: () => [root],
      discover: async () => { if (operation === 'scan') { started = true; await gate; assert.equal(closed, false) } return [file] },
      stat: async () => { started = true; await gate; assert.equal(closed, false); return file },
      peek: async () => ({ harness: 'test', nativeId: 'test', path }),
      read: async () => null, close: () => { closed = true },
    }
    const catalog = new SessionCatalog([provider]); catalogs.push(catalog)
    if (operation === 'reconcile') { await catalog.scan(); catalog.follow(path, 7, () => {}) }
    const task = operation === 'scan' ? catalog.scan() : catalog.reconcileActive()
    await until(() => started)
    const stopping = catalog.stop()
    assert.equal(closed, false)
    release()
    await Promise.all([task, stopping])
    assert.equal(closed, true)
    console.log(`Stop drains in-flight ${operation} before provider close`)
  }
} finally {
  for (const catalog of catalogs) await catalog.stop()
  await rm(root, { recursive: true, force: true })
}

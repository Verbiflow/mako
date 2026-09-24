import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { SessionCatalog, SessionArchive, connectDaemon, connectDaemonPort, serveCatalog, serveCatalogOnPort } from '../dist/index.js'

const root = await mkdtemp(join(tmpdir(), 'mako-catalog-serving-'))
const harnesses = ['claude', 'codex', 'cursor', 'grok', 'devin', 'opencode', 'future-provider']
const until = async (check) => {
  const deadline = Date.now() + 2000
  while (!check()) { assert.ok(Date.now() < deadline, 'condition settles within two seconds'); await sleep(10) }
}
try {
  for (const transport of ['port', 'socket']) {
    const dir = join(root, transport)
    await mkdir(dir)
    const gate = Promise.withResolvers(), entered = Promise.withResolvers()
    let closed = false
    const files = new Map()
    for (const harness of harnesses) {
      const path = join(dir, harness, 'session')
      await mkdir(join(dir, harness))
      await writeFile(path, 'before\n')
      files.set(harness, path)
    }
    const providers = harnesses.map(harness => {
      const path = files.get(harness)
      const stamp = async () => { const s = await stat(path); return { path, bytes: s.size, mtimeMs: s.mtimeMs } }
      const ref = { harness, nativeId: harness, path, title: 'Reader fixture' }
      return {
        harness, displayName: harness, roots: () => [join(dir, harness)],
        discover: async () => [await stamp()], stat: stamp,
        peek: async file => ({ ...ref, ...file }),
        read: async () => ({ ref, entries: (await readFile(path, 'utf8')).trim().split('\n').map(text => ({ kind: 'user', text })) }),
      }
    })
    providers.push({
      harness: 'slow', displayName: 'Slow discovery', roots: () => [join(dir, 'unrelated')],
      discover: async () => { entered.resolve(); await gate.promise; assert.equal(closed, false); return [] },
      peek: async () => null, read: async () => null, close: () => { closed = true },
    })
    const archivePath = join(dir, 'archive')
    const retained = { ref: { harness: 'archived-provider', nativeId: 'retained', path: join(dir, 'pruned') }, entries: [{ kind: 'user', text: 'Retained after pruning' }] }
    const writer = new SessionArchive(archivePath)
    await writer.load()
    writer.note(retained.ref, async () => retained)
    await writer.flush()
    await writer.stop()
    const catalog = new SessionCatalog(providers, { archivePath, cachePath: join(dir, 'cache.json') })
    const prepare = catalog.prepare()
    assert.equal(catalog.prepare(), prepare, 'preparation is shared, never a second cache hydration')
    await prepare
    const discovery = catalog.scan().then(refs => { catalog.startWatching(); return refs })
    let server, client
    if (transport === 'port') {
      const channel = new MessageChannel()
      server = serveCatalogOnPort(catalog, channel.port1, { discovery, memoryGuard: false })
      client = await connectDaemonPort(channel.port2)
    } else {
      const path = join(dir, 'daemon.sock')
      server = await serveCatalog(catalog, path, undefined, { discovery, memoryGuard: false })
      client = await connectDaemon(path)
    }
    let releaseFollow
    try {
      await entered.promise
      let listed = false
      const listing = client.list().then(refs => { listed = true; return refs })
      const started = performance.now()
      for (const harness of harnesses) {
        const page = await client.page(files.get(harness))
        assert.equal(page.ref.harness, harness)
        assert.equal(page.entries[0].text, 'before')
        assert.equal(listed, false, 'a known-path page must finish before unrelated discovery')
      }
      assert.equal((await client.open(retained.ref.path)).entries[0].text, 'Retained after pruning')
      assert.equal(await client.page(join(dir, 'absent')), null)
      const changes = []
      releaseFollow = client.onEvent(event => { if (event.event === 'entries') changes.push(event) })
      await client.follow(files.get('codex'), 0)
      await appendFile(files.get('codex'), 'during discovery\n')
      await until(() => changes.some(event => event.entries.some(entry => entry.text === 'during discovery')))
      assert.equal(listed, false, 'live follow delivery must not wait for unrelated discovery')
      console.log(`${transport}: all-six/future known paths and archived history available; follow delivered before discovery release (${Math.round(performance.now() - started)} ms including file-stat polling)`)
      gate.resolve()
      const refs = await listing
      assert.equal(refs.length, harnesses.length + 1, 'the list includes every native and retained session')
      const stopping = catalog.stop()
      catalog.startWatching()
      await stopping
      assert.equal(catalog.watchers.size, 0, 'late startup cannot resurrect a stopped catalog')
      assert.equal(catalog.observations.size, 0)
      assert.equal(catalog.pollTimer, null)
    } finally {
      gate.resolve()
      releaseFollow?.()
      client.close()
      server.close()
      await catalog.stop()
    }
  }
  // Failed discovery is an error for lists, never a successful empty catalog.
  const catalog = new SessionCatalog([])
  const gate = Promise.withResolvers()
  void gate.promise.catch(() => {})
  const channel = new MessageChannel()
  const server = serveCatalogOnPort(catalog, channel.port1, { discovery: gate.promise, memoryGuard: false })
  const client = await connectDaemonPort(channel.port2)
  const failed = assert.rejects(client.list(), /fixture discovery failed/)
  gate.reject(new Error('fixture discovery failed'))
  await failed
  client.close(); server.close(); await catalog.stop()
  console.log('Discovery failure remains an error; no partial list is marked complete')

  // A socket read may contain events both before and after the list reply.
  // Applying a buffered pre-snapshot event later would overwrite newer metadata.
  const port = new EventEmitter()
  const ref = title => ({ harness: 'fixture', nativeId: 'same', path: '/same', title })
  port.postMessage = raw => {
    const request = JSON.parse(raw)
    queueMicrotask(() => {
      const send = frame => port.emit('message', JSON.stringify(frame))
      if (request.op === 'ping') send({ id: request.id, ok: true, result: { pid: process.pid, startedAt: 1, sessions: 1, version: 31 } })
      else if (request.op === 'list') {
        send({ event: 'updated', ref: ref('older event') })
        send({ id: request.id, ok: true, result: [ref('snapshot')] })
        send({ event: 'updated', ref: ref('newer event') })
      }
    })
  }
  let portClosed = false
  port.close = () => { if (!portClosed) { portClosed = true; port.emit('close') } }
  const ordered = await connectDaemonPort(port)
  const order = []
  ordered.onEvent(event => order.push(event.ref.title))
  await ordered.list({}, refs => order.push(refs[0].title))
  assert.deepEqual(order, ['older event', 'snapshot', 'newer event'])
  ordered.close()
  console.log('List snapshots publish between earlier and later events, including one batched transport delivery')
} finally {
  await rm(root, { recursive: true, force: true })
}

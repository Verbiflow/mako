import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionCatalog } from '../dist/catalog.js'
const root = await mkdtemp(join(tmpdir(), 'mako-discovery-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const harnesses = ['claude', 'codex', 'cursor', 'grok', 'devin', 'opencode']
let configured = root, scans = 0, peeks = 0, unavailable = false, gate, entered = false, closed = false
const providers = harnesses.map(harness => ({
  harness, displayName: harness, roots: () => [join(configured, harness)],
  discover: async () => {
    scans++
    if (gate) { entered = true; await gate; assert.equal(closed, false) }
    if (unavailable) throw Error('store unavailable')
    const dir = join(configured, harness)
    const names = await readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    return Promise.all(names.map(async name => { const path = join(dir, name), info = await stat(path); return { path, bytes: info.size, mtimeMs: info.mtimeMs } }))
  },
  peek: async file => { peeks++; return { harness, nativeId: file.path, title: 'new session', ...file } },
  read: async () => null,
  close: () => { closed = true },
}))
const catalog = new SessionCatalog(providers)
try {
  await catalog.scan()
  catalog.startWatching()
  assert.equal(catalog.watchers.size, 0, 'initial roots are absent')
  assert.ok(catalog.pollTimer, 'discovery is scheduled without a watcher error')
  const events = []
  catalog.onEvent(event => events.push(event))
  for (const harness of harnesses) {
    await mkdir(join(root, harness))
    await writeFile(join(root, harness, 'first'), 'new')
  }
  const start = performance.now()
  const deadline = Date.now() + 33_000
  while (catalog.count !== 6) { assert.ok(Date.now() < deadline, 'production discovery interval finds new sessions'); await sleep(50) }
  assert.equal(events.filter(e => e.type === 'added').length, 6)
  assert.equal(catalog.watchers.size, 6, 'new roots receive subscriptions')
  console.log(`All six shared contracts: missing roots and unknown sessions discovered in ${(performance.now() - start).toFixed(1)} ms`)
  for (const watcher of catalog.watchers.values()) watcher.close()
  for (const harness of harnesses) await writeFile(join(root, harness, 'second'), 'newer')
  await catalog.reconcileDiscovery()
  assert.equal(catalog.count, 12, 'silent successful watchers cannot hide new sessions')
  const before = peeks
  const idleStart = performance.now(), cpuStart = process.cpuUsage()
  await catalog.reconcileDiscovery()
  assert.equal(peeks, before, 'unchanged discovery does not parse sessions')
  console.log(JSON.stringify({ idleSweepMs: performance.now() - idleStart, idleSweepCpuMicros: process.cpuUsage(cpuStart), peeks: peeks - before }))
  unavailable = true
  await catalog.reconcileDiscovery()
  await catalog.rescanProvider(providers[0])
  assert.equal(catalog.count, 12, 'failed discovery preserves known sessions')
  unavailable = false
  configured = join(root, 'changed')
  for (const harness of harnesses) await mkdir(join(configured, harness), { recursive: true })
  await catalog.reconcileDiscovery()
  assert.deepEqual([...catalog.watchers.keys()].sort(), harnesses.map(h => join(configured, h)).sort(), 'changed roots replace subscriptions')
  let release
  gate = new Promise(resolve => { release = resolve })
  const priorScans = scans, first = catalog.reconcileDiscovery()
  const second = catalog.reconcileDiscovery()
  assert.equal(first, second, 'overlapping periodic requests share work')
  while (!entered) await sleep(1)
  const stopping = catalog.stop()
  assert.equal(closed, false)
  release()
  await Promise.all([first, second, stopping])
  assert.equal(scans - priorScans, 6)
  assert.equal(closed, true)
  assert.equal(catalog.watchers.size, 0)
  assert.equal(catalog.pollTimer, null)
  const finalEvents = events.length
  await catalog.reconcileDiscovery()
  assert.equal(events.length, finalEvents, 'no work after stop')
  console.log('Silent events, unchanged cache, unavailable discovery, changed roots, single flight and shutdown passed')
} finally {
  await catalog.stop()
  await rm(root, { recursive: true, force: true })
}

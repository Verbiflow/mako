import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionCatalog } from '../dist/index.js'

// Warm threads are weighed by the text they hold. A database record's `bytes`
// is a position, so it must not count against the cache either way.
const root = await mkdtemp(join(tmpdir(), 'mako-thread-cache-'))
const store = (harness, sessions) => {
  const reads = new Map()
  const stampOf = (path) => ({ path, bytes: sessions.get(path).bytes, mtimeMs: 1 })
  return {
    reads,
    provider: {
      harness, displayName: harness, roots: () => [join(root, harness)],
      discover: async () => [...sessions.keys()].map(stampOf),
      stat: async (path) => sessions.has(path) ? stampOf(path) : null,
      peek: async (file) => ({ harness, nativeId: file.path, path: file.path, ...file }),
      read: async (path) => {
        reads.set(path, (reads.get(path) ?? 0) + 1)
        return { ref: { harness, nativeId: path, path, ...stampOf(path) }, entries: [{ kind: 'user', text: sessions.get(path).text }] }
      },
    },
  }
}

try {
  // OpenCode stamps a revision of millisecond time × 1000: far past any size.
  const revisions = new Map(Array.from({ length: 16 }, (_, index) => [
    join(root, 'opencode', `session-${index}`),
    { bytes: 1_791_446_976_000_000 + index, text: `Prompt ${index}` },
  ]))
  const opencode = store('opencode', revisions)
  // The newest Devin CLI node id is small however much the session holds.
  const large = 'x'.repeat(40 * 1024 * 1024)
  const nodes = new Map(Array.from({ length: 3 }, (_, index) => [
    join(root, 'devin', `session-${index}`),
    { bytes: 200_000 + index, text: large },
  ]))
  const devin = store('devin', nodes)
  const catalog = new SessionCatalog([opencode.provider, devin.provider], { cachePath: join(root, 'cache.json') })
  await catalog.scan()

  for (const path of revisions.keys()) await catalog.open(path, false)
  for (const path of revisions.keys()) await catalog.open(path, false)
  assert.deepEqual([...opencode.reads.values()], Array(16).fill(1), 'sixteen small threads stay warm whatever their revision reads')

  const [first, , last] = nodes.keys()
  for (const path of nodes.keys()) await catalog.open(path, false)
  await catalog.open(last, false)
  assert.equal(devin.reads.get(last), 1, 'the newest large thread stays warm')
  await catalog.open(first, false)
  assert.equal(devin.reads.get(first), 2, 'three 80 MB translations outgrow the 192 MB budget, so the oldest was let go')
  await catalog.stop()
  console.log('thread cache: weighed by translated text, not by native stamps')
} finally {
  await rm(root, { recursive: true, force: true })
}

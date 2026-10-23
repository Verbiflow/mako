import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionCatalog } from '../dist/catalog.js'

// One harness, two stores (Devin's CLI and Devin.app are two providers): a rescan of each reads its own store. Keyed
// by harness, the second's rescan joined the first's and read the first store again, so a session restored into the
// second store (a move's arrival writing Devin's app store) wasn't listed, and the arrival refused it.
const root = await mkdtemp(join(tmpdir(), 'mako-rescan-providers-'))
const provider = name => ({
  harness: 'devin', displayName: name, roots: () => [join(root, name)], rescanRoot: () => true,
  discover: async () => {
    const dir = join(root, name)
    const names = await readdir(dir)
    return Promise.all(names.map(async file => { const path = join(dir, file), info = await stat(path); return { path, bytes: info.size, mtimeMs: info.mtimeMs } }))
  },
  peek: async file => ({ harness: 'devin', nativeId: `${name}:${file.path.split('/').at(-1)}`, title: 'restored', ...file }),
  read: async () => null,
})
const cli = provider('cli'), app = provider('app')
for (const name of ['cli', 'app']) await mkdir(join(root, name))
const catalog = new SessionCatalog([cli, app])
try {
  await catalog.scan()
  assert.equal(catalog.count, 0)
  await writeFile(join(root, 'cli', 'one'), 'written')
  await writeFile(join(root, 'app', 'two'), 'written')
  // Both asked at once, as a receive asks every provider of the harnesses it wrote.
  await Promise.all([catalog.rescanProvider(cli), catalog.rescanProvider(app)])
  assert.deepEqual(catalog.list().map(ref => ref.nativeId).sort(), ['app:two', 'cli:one'], 'each store read on its own')
  console.log('PASS: two providers of one harness each rescan their own store, asked at once')
} finally {
  await catalog.stop()
  await rm(root, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { persistThreadAttachments } from '../dist/attachment-storage.js'

const root = await fs.mkdtemp(join(tmpdir(), 'mako-retention-test-'))
const assets = join(root, 'assets')
const source = join(root, 'original.txt')
const attachment = (source, name = 'proof.txt') => ({ type: 'attachment', name, mimeType: 'text/plain', source })
const file = attachment({ kind: 'file', path: source })
const inline = attachment({ kind: 'inline', data: Buffer.from('original bytes').toString('base64') })
const thread = a => ({ ref: { harness: 'test', nativeId: 'retention', path: join(root, 'native') }, entries: [{ kind: 'user', text: 'look', attachments: [a] }] })
const saved = t => t.entries[0].attachments[0]
const mutations = []
const originals = new Map()
for (const name of ['mkdir', 'writeFile', 'copyFile', 'rename', 'link', 'rm']) {
  originals.set(name, fs[name])
  fs[name] = async (...args) => { mutations.push({ name, path: String(args[0]) }); return originals.get(name)(...args) }
}
syncBuiltinESMExports()
const restore = () => { for (const [name, fn] of originals) fs[name] = fn; syncBuiltinESMExports() }
try {
  await fs.writeFile(source, 'original bytes')
  const first = await persistThreadAttachments(thread(file), assets)
  const retained = saved(first)
  const before = await fs.stat(retained.source.path)
  mutations.length = 0
  for (const input of [thread(file), thread(inline), first]) {
    const next = await persistThreadAttachments(input, assets, first)
    assert.equal(saved(next).source.path, retained.source.path)
  }
  assert.deepEqual(mutations, [], 'intact repeats must perform zero filesystem mutations, including temp creation/cleanup')
  assert.equal((await fs.stat(retained.source.path)).ino, before.ino)
  console.log('PASS intact inline, original-file and retained-file repeats perform zero mutations')

  await fs.writeFile(source, 'new original')
  const changed = saved(await persistThreadAttachments(thread(file), assets, first))
  assert.notEqual(changed.source.path, retained.source.path)
  assert.equal(await fs.readFile(changed.source.path, 'utf8'), 'new original')
  assert.equal(await fs.readFile(retained.source.path, 'utf8'), 'original bytes')
  await fs.rm(source)
  assert.deepEqual(saved(await persistThreadAttachments(thread(file), assets, first)), retained)
  console.log('PASS changed originals create separate snapshots; missing originals retain verified prior bytes')

  await fs.writeFile(retained.source.path, 'corrupt bytes!')
  assert.equal(saved(await persistThreadAttachments(thread(file), assets, first)).source.kind, 'unavailable')
  await fs.writeFile(source, 'different original')
  assert.equal(saved(await persistThreadAttachments(first, assets)).source.kind, 'unavailable', 'historical corruption must not silently become newer bytes')
  await fs.writeFile(source, 'original bytes')
  assert.equal(saved(await persistThreadAttachments(first, assets)).source.path, retained.source.path)
  assert.equal(await fs.readFile(retained.source.path, 'utf8'), 'original bytes')
  await fs.rm(retained.source.path)
  assert.equal(saved(await persistThreadAttachments(first, assets)).source.path, retained.source.path)
  assert.equal(await fs.readFile(retained.source.path, 'utf8'), 'original bytes')
  console.log('PASS missing/corrupt snapshots repair only from matching historical bytes')

  await fs.writeFile(retained.source.path, 'corrupt bytes!')
  assert.equal(saved(await persistThreadAttachments(thread(inline), assets)).source.path, retained.source.path)
  assert.equal(await fs.readFile(retained.source.path, 'utf8'), 'original bytes')
  const inlineSaved = await persistThreadAttachments(thread(attachment(inline.source, 'inline-only.txt')), assets)
  await fs.writeFile(saved(inlineSaved).source.path, 'broken')
  assert.equal(saved(await persistThreadAttachments(inlineSaved, assets)).source.kind, 'unavailable')
  console.log('PASS inline bytes repair corruption; lost inline snapshots never rebrand damaged bytes')

  // A source may change after the first hash but before the copy. Address the actual copied bytes.
  const copy = originals.get('copyFile')
  fs.copyFile = async (from, to, ...rest) => {
    if (from === source) await originals.get('writeFile')(source, 'changed during capture')
    return copy(from, to, ...rest)
  }
  syncBuiltinESMExports()
  await fs.writeFile(source, 'before capture')
  const raced = saved(await persistThreadAttachments(thread(file), join(root, 'raced')))
  const racedBytes = await fs.readFile(raced.source.path)
  assert.equal(racedBytes.toString(), 'changed during capture')
  assert.ok(basename(raced.source.path).startsWith(createHash('sha256').update(racedBytes).digest('hex') + '-'))
  fs.copyFile = copy
  syncBuiltinESMExports()
  console.log('PASS source changes during copying cannot publish bytes under the wrong hash')

  // Publication failure must not silently substitute an older snapshot for known new bytes.
  await fs.writeFile(source, 'unsaved new bytes')
  const invalidRoot = join(root, 'not-a-directory')
  await fs.writeFile(invalidRoot, 'block mkdir')
  assert.equal(saved(await persistThreadAttachments(thread(file), invalidRoot, first)).source.kind, 'unavailable')
  assert.deepEqual(saved(await persistThreadAttachments(thread(inline), invalidRoot)), inline)
  console.log('PASS failed publication preserves inline input and refuses stale file fallback')

  // Independent processes, not just promises sharing module state.
  restore()
  const concurrentRoot = join(root, 'concurrent')
  const moduleUrl = new URL('../dist/attachment-storage.js', import.meta.url).href
  const worker = `import { persistThreadAttachments } from ${JSON.stringify(moduleUrl)}; const result = await persistThreadAttachments(${JSON.stringify(thread(inline))}, ${JSON.stringify(concurrentRoot)}); console.log(JSON.stringify(result));`
  const run = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', worker])
  const results = await Promise.all(Array.from({ length: 8 }, run))
  const paths = results.map(r => saved(JSON.parse(r.stdout)).source.path)
  assert.equal(new Set(paths).size, 1)
  assert.equal(await fs.readFile(paths[0], 'utf8'), 'original bytes')
  assert.deepEqual(await fs.readdir(concurrentRoot), [basename(paths[0])])
  const winner = await fs.stat(paths[0])
  await Promise.all(Array.from({ length: 8 }, run))
  assert.equal((await fs.stat(paths[0])).ino, winner.ino)
  await fs.writeFile(paths[0], 'corrupt bytes!')
  await Promise.all(Array.from({ length: 8 }, run))
  assert.equal(await fs.readFile(paths[0], 'utf8'), 'original bytes')
  assert.deepEqual(await fs.readdir(concurrentRoot), [basename(paths[0])])
  console.log('PASS independent processes converge on complete assets; warm saves preserve inode; concurrent repair leaves no temporary files')

  const mixed = { ...thread(inline), entries: [
    { kind: 'user', text: 'user', attachments: [inline] },
    { kind: 'assistant', blocks: [inline, { type: 'tool', name: 'image', attachments: [inline] }] },
  ] }
  const mixedSaved = await persistThreadAttachments(mixed, assets)
  assert.equal(mixedSaved.entries[0].attachments[0].source.kind, 'file')
  assert.equal(mixedSaved.entries[1].blocks[0].source.kind, 'file')
  assert.equal(mixedSaved.entries[1].blocks[1].attachments[0].source.kind, 'file')
  console.log('PASS user, assistant and tool attachments retain their placement and metadata')
} finally {
  restore()
  await fs.rm(root, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionArchive } from '../dist/archive.js'
import { ReadOnlyConnection, ReadOnlyStoreError, openNativeStore, openReadOnly, restrictNativeStores } from '../dist/read-only-sqlite.js'

/**
 * A connection that must never write reads a WAL database another process
 * writes: it holds the main file and `-shm` open read-only (`-wal` is opened
 * read-write by SQLite whenever it is read), creates no file, refuses writes,
 * and sees the writer's commits; with no writer it reads a snapshot and goes
 * live once one appears. The session archive and native stores read this way.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mako-read-only-stores-')))
const sides = (path) => ({ wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) })

/** A read-write connection in another process, so SQLite shares no file handle with the reader. */
function writerProcess(path) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite'
    import { createInterface } from 'node:readline'
    const db = new DatabaseSync(${JSON.stringify(path)})
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t (v TEXT)')
    console.log('ready')
    for await (const line of createInterface({ input: process.stdin })) {
      if (line === 'close') { db.close(); console.log('closed'); process.exit(0) }
      db.prepare('INSERT INTO t VALUES (?)').run(line)
      console.log('wrote')
    }
  `], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const next = async () => (await lines.next()).value
  return {
    ready: next(),
    send: async (line) => { child.stdin.write(`${line}\n`); return next() },
  }
}

/** lsof's access mode for each of this process's open handles on `path` and its side files. */
function modes(path) {
  let out = ''
  try { out = execFileSync('lsof', ['-nP', '-w', '-a', '-p', String(process.pid), '-Fan'], { encoding: 'utf8' }) } catch (error) { out = error.stdout ?? '' }
  const found = {}
  let access = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('a')) access = line.slice(1)
    if (line.startsWith('n') && line.slice(1).startsWith(path)) (found[line.slice(1 + path.length) || 'main'] ??= []).push(access)
  }
  return found
}

const count = (database) => database.prepare('SELECT count(*) AS n FROM t').get().n

try {
  {
    const path = join(root, 'live.sqlite')
    const writer = writerProcess(path)
    assert.equal(await writer.ready, 'ready')
    assert.equal(await writer.send('one'), 'wrote')
    const { database, access } = openReadOnly(path)
    assert.equal(access, 'live', 'a database another process has open is read live')
    assert.equal(count(database), 1)
    assert.throws(() => database.exec("INSERT INTO t VALUES ('reader')"), /readonly/, 'the reader cannot write')
    assert.equal(await writer.send('two'), 'wrote')
    assert.equal(count(database), 2, "the writer's later commit is visible")
    const held = modes(path)
    assert.deepEqual(held.main, ['r'], `the main file is open read-only: ${JSON.stringify(held)}`)
    assert.ok(held['-shm']?.length && held['-shm'].every((mode) => mode === 'r' || mode === ' ' || mode === ''), `-shm is mapped read-only: ${JSON.stringify(held)}`)
    database.close()
    assert.equal(await writer.send('close'), 'closed')
    assert.deepEqual(sides(path), { wal: false, shm: false }, 'the last writer still cleans up after a reader')
  }

  {
    const path = join(root, 'snapshot.sqlite')
    const seed = new DatabaseSync(path)
    seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('one')")
    seed.close()
    assert.deepEqual(sides(path), { wal: false, shm: false })
    const reader = new ReadOnlyConnection(path)
    assert.equal(reader.access, 'snapshot', 'with no writer the main file is read as it is')
    assert.equal(count(reader.database), 1)
    assert.deepEqual(sides(path), { wal: false, shm: false }, 'reading creates neither -wal nor -shm')
    assert.deepEqual(modes(path), { main: ['r'] }, 'and holds only the main file, read-only')
    assert.equal(reader.refresh(), false, 'an unchanged snapshot stays open')
    const writer = writerProcess(path)
    await writer.ready
    await writer.send('two')
    assert.equal(reader.refresh(), true, 'a writer appearing reopens the snapshot')
    assert.equal(reader.access, 'live')
    assert.equal(count(reader.database), 2)
    await writer.send('three')
    assert.equal(count(reader.database), 3, 'and from then on commits are followed live')
    reader.close()
    await writer.send('close')
    assert.throws(() => openReadOnly(join(root, 'missing.sqlite')), 'a missing database is not created')
    assert.equal(existsSync(join(root, 'missing.sqlite')), false)
  }

  {
    const location = join(root, 'archive')
    const writer = new SessionArchive(location)
    const reader = new SessionArchive(location, undefined, { readOnly: true })
    const value = (name) => ({ ref: { harness: 'fixture', nativeId: name, path: `/fixture/${name}`, revision: name, bytes: 1 }, entries: [{ kind: 'user', text: name }] })
    const missing = new SessionArchive(join(root, 'no-archive'), undefined, { readOnly: true })
    await missing.load()
    assert.equal(missing.has('/fixture/one'), false)
    assert.equal(existsSync(join(root, 'no-archive')), false, 'a read-only archive creates nothing')
    await missing.stop()

    writer.note(value('one').ref, async () => value('one'))
    await writer.flush()
    await reader.load()
    assert.equal((await reader.read('/fixture/one'))?.entries[0].text, 'one', 'a read-only archive reads what a writer kept')
    let captured = false
    reader.note(value('two').ref, async () => { captured = true; return value('two') })
    await reader.flush()
    assert.equal(captured, false, 'a read-only archive captures nothing')
    await assert.rejects(reader.forget('/fixture/one'), ReadOnlyStoreError)
    assert.equal(writer.has('/fixture/one'), true, 'and forgets nothing')
    writer.note(value('three').ref, async () => value('three'))
    await writer.flush()
    assert.equal(reader.has('/fixture/three'), true, "the writer's later copy is listed")
    await reader.stop()
    await writer.stop()
  }

  {
    const path = join(root, 'native.sqlite')
    const seed = new DatabaseSync(path)
    seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('one')")
    seed.close()
    const shared = openNativeStore(path)
    count(shared)
    shared.close()
    assert.deepEqual(sides(path), { wal: true, shm: true }, 'a plain read-only open creates -wal and -shm in the harness folder')
    rmSync(`${path}-wal`)
    rmSync(`${path}-shm`)
    restrictNativeStores()
    const strict = openNativeStore(path)
    assert.equal(count(strict), 1)
    assert.deepEqual(sides(path), { wal: false, shm: false }, 'a restricted catalog creates nothing beside a native store')
    assert.throws(() => strict.exec("INSERT INTO t VALUES ('two')"), /readonly/)
    strict.close()
  }
  console.log('PASS: read-only stores open the main file and -shm read-only, create no file, refuse writes, and follow a writer live')
} finally {
  rmSync(root, { recursive: true, force: true })
}

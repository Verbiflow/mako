import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as sleep } from "node:timers/promises"
import { zstdCompressSync } from "node:zlib"
import { AttachmentSweep, headOf, namesIn, tailsOf } from "../dist/attachment-sweep.js"
import { logEntries, snappyDecompress, tableEntries } from "../dist/leveldb-text.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordCapture } from "../dist/record-capture.js"
import { noteCarried } from "../dist/record-carried.js"
import { RecordStore } from "../dist/record-store.js"
import { SessionCatalog } from "../dist/catalog.js"

/**
 * Mako's attachment files (the archive's `assets/`, each profile's
 * `LiveAssets`, the staged `~/.mako/attachments`) go only once no reader on
 * the machine names them: every profile's journals, views and drafts are
 * marked, and every browser a desk opened in, by loopback origin; a file
 * written while the pass runs is never taken, nor one named mid-pass; a
 * root that can't be read holds everything, and a hold holds what existed by
 * its time; a crash between the trash and the delete loses nothing; a session
 * the store holds restores its own copy; and a pass with nothing changed
 * does nothing. Fixture folders only.
 */

const GRACE = 400
const control = { stopped: () => false, yieldToPerson: async () => {} }
const root = await mkdtemp(join(tmpdir(), "mako-attachment-sweep-"))
/** How far past the real clock the sweep's clock runs: a test moves it a day on to see what's deleted. */
let ahead = 0
const now = () => Date.now() + ahead
const DAY = 24 * 60 * 60_000

try {
  const shared = join(root, "home", ".mako")
  const archive = join(shared, "archive")
  const assets = join(archive, "assets")
  const trash = join(archive, "assets-trash")
  const staged = join(shared, "attachments")
  const views = join(shared, "views")
  const appData = join(root, "Application Support")
  const installed = join(appData, "mako")
  const dev = join(appData, "mako-dev")
  const devClient = join(appData, "mako-dev-ui-desk")
  const outside = join(root, "elsewhere", "fixture-profile")
  const live = join(dev, "conversations", "assets")
  const browser = join(root, "Chrome", "Default", "Local Storage", "leveldb")
  const firefox = join(root, "Firefox", "http+++127.0.0.1+5173", "ls", "data.sqlite")
  for (const folder of [assets, staged, views, live, join(installed, "conversations"), join(devClient, "Local Storage", "leveldb"), join(outside, "conversations"), browser, join(firefox, "..")])
    await mkdir(folder, { recursive: true })
  const holds = []
  const readers = {
    roots: [installed, dev, devClient, outside],
    browsers: [{ path: browser, kind: "chromium", label: "Chrome Default" }, { path: firefox, kind: "firefox", label: "firefox fixture" }],
    holds,
    unreadable: [],
  }
  const sweeper = (options = {}) => new AttachmentSweep({ archive, views, readers: async () => readers, graceMs: GRACE, now, ...options })
  const where = (file) => file.folder
  const there = (file) => existsSync(join(where(file), file.name))
  const trashed = (file) => existsSync(join(`${where(file)}-trash`, file.name))

  const write = async (label, folder = assets, name) => {
    const bytes = Buffer.from(`attachment ${label} ${"x".repeat(2000)}`)
    const digest = createHash("sha256").update(bytes).digest("hex")
    const file = name ?? `${digest}-image`
    await writeFile(join(folder, file), bytes)
    return { label, bytes, digest, name: file, folder, path: join(folder, file) }
  }
  const entriesNaming = (...files) => JSON.stringify(files.map((file, index) => ({
    type: "user", id: `u${index}`, text: "look",
    attachments: [{ type: "attachment", name: "image", mimeType: "image/png", source: { kind: "file", path: file.path } }],
  })))
  const refOf = (id) => JSON.stringify({ harness: "codex", nativeId: id, path: `/s/${id}.jsonl`, title: id })
  const sqlite = (path, schema, rows = []) => {
    const db = new DatabaseSync(path)
    db.exec(schema)
    for (const [sql, ...values] of rows) db.prepare(sql).run(...values)
    db.close()
  }

  const byArchive = await write("named by the archive")
  const byJournal = await write("named by another profile's journal")
  const byOutside = await write("named by a profile outside app data")
  const byView = await write("named only by a view")
  const byDraft = await write("named by a draft")
  const byTable = await write("named by a draft kept in a table file")
  const byLegacy = await write("named by a legacy folder")
  const byBrowser = await write("named by a draft in Chrome")
  const byFirefox = await write("named by a draft in Firefox")
  const otherSite = await write("named only under another site's origin")
  const orphan = await write("named by nothing")
  const reused = await write("named mid-pass by an older build")
  const liveNamed = await write("a prompt's file named by its journal", live, "0f6c2b7e-0000-4000-8000-00000000000a-shot.png")
  const liveOrphan = await write("a LiveAssets file nothing names", live, "0f6c2b7e-0000-4000-8000-00000000000b-old.png")
  // Staged as `files.ts` names them: the time in base 36, a random number, the name.
  const stamp = (offset = 0) => `${(Date.now() + offset).toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`
  const stagedNamed = await write("staged and named by a request", staged, `${stamp()}-notes.txt`)
  const stagedHeld = await write("staged before the record began", staged, `${stamp()}-draft.png`)
  const stagedHashed = await write("written by an earlier build's translation", staged)
  const named = [byArchive, byJournal, byOutside, byView, byDraft, byTable, byLegacy, byBrowser, byFirefox]

  // The archive's rows, with the token its triggers keep; a folder of the oldest builds.
  sqlite(join(archive, "archive.sqlite"), `
    CREATE TABLE sessions (path TEXT PRIMARY KEY, ref TEXT NOT NULL, entries TEXT NOT NULL, revision TEXT NOT NULL);
    CREATE TABLE archive_captures (path TEXT PRIMARY KEY, token TEXT NOT NULL, deleted INTEGER NOT NULL);
    PRAGMA user_version = 1;
  `, [
    ["INSERT INTO sessions VALUES (?, ?, ?, ?)", "/s/one.jsonl", refOf("one"), entriesNaming(byArchive), "1"],
    ["INSERT INTO archive_captures VALUES (?, ?, 0)", "/s/one.jsonl", "t1"],
  ])
  await mkdir(join(archive, "0123456789abcdef01234567"))
  await writeFile(join(archive, "0123456789abcdef01234567", "entries.jsonl"), `${entriesNaming(byLegacy)}\n`)
  // Another profile's journal: history copied from the archive in `base` (larger than a read's piece: 5 MiB), a request naming a LiveAssets file and a staged one.
  const big = `${"y".repeat(5 * 1024 * 1024)}${entriesNaming(byJournal)}`
  sqlite(join(dev, "conversations", "6f1c2b7e-0000-4000-8000-000000000001.sqlite"), `
    CREATE TABLE base (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE requests (id TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  `, [
    ["INSERT INTO base VALUES (?, ?)", 9_000_000_000_000, big],
    ["INSERT INTO requests VALUES (?, ?)", "r1", JSON.stringify({ text: `see <item path="${stagedNamed.path}"/>`, attachments: [{ path: liveNamed.path }] })],
  ])
  // A host whose data root is outside app data, with its own journal, naming by `originalPath` in JSON kept inside a string.
  sqlite(join(outside, "conversations", "6f1c2b7e-0000-4000-8000-000000000002.sqlite"), "CREATE TABLE blocks (id INTEGER PRIMARY KEY, value TEXT NOT NULL)", [
    ["INSERT INTO blocks VALUES (?, ?)", -5, JSON.stringify({ text: JSON.stringify({ originalPath: byOutside.path }) })],
  ])
  // A view, its body zstd-compressed as `view-cache.ts` keeps one past 1 KiB.
  sqlite(join(views, "abc.view.db"), "CREATE TABLE entries (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, type TEXT NOT NULL, body BLOB NOT NULL)", [
    ["INSERT INTO entries VALUES (?, ?, ?, ?)", 0, "u0", "user", zstdCompressSync(Buffer.from(entriesNaming(byView)))],
  ])
  // A draft in the dev client's localStorage: a log record, its value UTF-16 as Chromium keeps one with any non-Latin-1 character.
  const utf16 = (text) => Buffer.concat([Buffer.from([0]), Buffer.from(text, "utf16le")])
  await writeFile(join(devClient, "Local Storage", "leveldb", "000003.log"), leveldbLog([[Buffer.from("_mako-app://desk\0\u0001draft:x"), utf16(JSON.stringify({ text: "über", attachments: [{ stagedPath: byDraft.path }] }))]]))
  // And one kept in a table, its block Snappy-compressed.
  await writeFile(join(devClient, "Local Storage", "leveldb", "000005.ldb"), leveldbTable(Buffer.from("_mako-app://desk\0\u0001draft:y"), Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify({ stagedPath: byTable.path, pad: "ab".repeat(40) }), "latin1")])))
  // A desk opened in Chrome from Vite's port: its draft is read; another site's value in the same folder is not.
  await writeFile(join(browser, "000007.log"), leveldbLog([
    [Buffer.from("_http://127.0.0.1:5173\0\u0001mako.attachment-drafts.v1"), Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify({ x: [{ stagedPath: byBrowser.path }] }))])],
    [Buffer.from("_https://example.com\0\u0001notes"), Buffer.concat([Buffer.from([1]), Buffer.from(`pasted ${otherSite.path}`)])],
  ]))
  // A desk opened in Firefox: its origin's store, the value Snappy-compressed.
  const firefoxValue = Buffer.from(JSON.stringify({ x: [{ stagedPath: byFirefox.path }] }))
  sqlite(firefox, "CREATE TABLE data (key TEXT PRIMARY KEY, utf16_length INTEGER, conversion_type INTEGER, compression_type INTEGER, last_access_time INTEGER, value BLOB)", [
    ["INSERT INTO data VALUES (?, ?, ?, ?, ?, ?)", "mako.attachment-drafts.v1", firefoxValue.length, 1, 1, 0, snappyLiteralBlock(firefoxValue)],
  ])
  await sleep(GRACE + 50)
  // Drafts before Mako recorded which browsers open a desk: held, staged files only.
  holds.push({ kinds: ["staged"], through: Date.now() - GRACE / 2, why: "drafts of a desk opened before the record" })
  await sleep(10)
  // Staged after it.
  const stagedOrphan = await write("staged, sent and forgotten", staged, `${stamp()}-done.png`)
  await sleep(GRACE + 50)

  // The readers' pieces on their own.
  {
    const tails = tailsOf(shared)
    const found = new Set()
    namesIn(Buffer.from(`x /a\\/archive\\/assets\\/${byArchive.digest}-image y archive\\\\assets\\\\${orphan.digest}-z archive/assets/${"f".repeat(63)}-short conversations/assets/${liveNamed.name} .mako/attachments/${stagedNamed.name}`), tails, found)
    assert.deepEqual([...found].sort(), [`archive:${byArchive.digest}`, `archive:${orphan.digest}`, `live:${headOf(liveNamed.name)}`, `staged:${headOf(stagedNamed.name)}`].sort(), "a name in any spelling and kind; a hash one short is no name")
    assert.equal(headOf("mg1abc-x7y-My Screenshot 2026.png"), "mg1abc-x7y", "a staged name's head is its time and number")
    assert.throws(() => snappyDecompress(Buffer.from([11, 2 << 2, 0x61, 0x62, 0x63])), /shorter/, "a Snappy block shorter than its length is refused")
    assert.equal(logEntries(Buffer.alloc(0)).length, 0)
    assert.throws(() => tableEntries(Buffer.alloc(64)), /magic/, "a table that isn't LevelDB's is refused, not read as nothing")
  }

  // A dry run reports and moves nothing.
  {
    const report = await sweeper({ state: null }).pass(control, { sweep: false })
    assert.equal(report.stopped, undefined, JSON.stringify(report.unreadable))
    const archived = report.folders.archive
    assert.equal(archived.named.files, named.length, JSON.stringify(report.owners))
    assert.equal(archived.reclaimable.files, 3, "nothing names the orphan, the file another site's value names, and the one named later")
    assert.equal(report.folders["live mako-dev"].named.files, 1)
    assert.equal(report.folders["live mako-dev"].reclaimable.files, 1)
    assert.deepEqual([report.folders.staged.named.files, report.folders.staged.held.files, report.folders.staged.kept.files, report.folders.staged.reclaimable.files], [1, 1, 1, 1], "staged: named, held, kept by its hash, and reclaimable")
    for (const owner of ["archive", "drafts mako-dev-ui-desk", "drafts Chrome Default", "drafts firefox fixture", "journals fixture-profile", "journals mako-dev", "views"]) assert.ok(report.owners[owner], `${owner} names something: ${Object.keys(report.owners)}`)
    assert.ok(!existsSync(trash) && !existsSync(join(shared, "attachment-sweep.json")), "a dry run writes nothing")
  }

  // The same pass with its reads in a child process of its own, as the catalog worker runs it.
  {
    const report = await sweeper({ state: null, aside: process.execPath }).pass(control, { sweep: false })
    assert.equal(report.folders.archive.named.files, named.length)
    assert.ok(report.childPeakRss > 0, "the reads ran in a child")
  }

  // The sweep: named files stay, an older build naming an old file mid-pass brings it straight back, a file written mid-pass isn't taken.
  let young
  {
    const report = await sweeper().pass(control, {
      sweep: true,
      afterMark: async () => {
        young = await write("written while the pass runs")
        const db = new DatabaseSync(join(archive, "archive.sqlite"))
        db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run("/s/two.jsonl", refOf("two"), entriesNaming(reused), "1")
        db.prepare("INSERT INTO archive_captures VALUES (?, ?, 0)").run("/s/two.jsonl", "t2")
        db.close()
      },
    })
    assert.equal(report.stopped, undefined)
    for (const file of [...named, liveNamed, stagedNamed, stagedHeld, stagedHashed]) assert.ok(there(file), `${file.label} stays`)
    assert.ok(there(young), "a file written while the pass runs isn't taken")
    assert.ok(there(reused) && !trashed(reused), "a file an older build named mid-pass came straight back")
    for (const file of [orphan, otherSite, liveOrphan, stagedOrphan]) assert.ok(!there(file) && trashed(file), `${file.label} went to its folder's trash`)
    assert.equal(report.folders.archive.restored, 1)
    assert.equal(report.folders.archive.deleted.files, 0, "nothing is deleted on the pass that trashed it")
  }

  // Idempotent: a pass with nothing changed reads nothing and moves nothing; one past its grace finds the same.
  {
    const quiet = await sweeper().pass(control, { sweep: true })
    assert.equal(quiet.ran, false, "nothing moved: the pass costs a stat of each source")
    await sleep(GRACE + 50)
    const again = await sweeper().pass(control, { sweep: true })
    assert.equal(again.ran, true, "the young file's grace ended, so the pass looks again")
    assert.equal(again.sources.read, 0, `every source as it was: ${JSON.stringify(again.slowest)}`)
    assert.ok(trashed(young), "the young file, still named by nothing, goes once its grace is over")
  }

  // A desk known to have run in a browser that can't be read holds every file of every kind that existed then.
  {
    holds.push({ kinds: ["archive", "live", "staged"], through: Date.now(), why: "drafts of a desk opened in safari" })
    const report = await sweeper().pass(control, { sweep: true })
    for (const file of [orphan, young, liveOrphan, stagedOrphan]) assert.ok(there(file), `${file.label} came back: the browser may name it`)
    assert.ok(report.owners["drafts of a desk opened in safari"])
    holds.pop()
  }

  // An unreadable profile root holds everything: nothing is trashed, and the trash comes back.
  {
    await sleep(GRACE + 50)
    await sweeper().pass(control, { sweep: true })
    assert.ok(trashed(orphan))
    const locked = join(appData, "mako-review")
    await mkdir(join(locked, "conversations"), { recursive: true })
    await chmod(locked, 0o000)
    try {
      const report = await sweeper({ readers: async () => ({ ...readers, roots: [...readers.roots, locked] }) }).pass(control, { sweep: true })
      assert.match(report.stopped ?? "", /mako-review/, "the root that can't be read is named")
      assert.ok(there(orphan) && there(young) && there(liveOrphan), "what it might name came back from the trash")
      const listing = await sweeper({ readers: async () => ({ ...readers, unreadable: [{ path: appData, why: "EACCES" }] }) }).pass(control, { sweep: true })
      assert.ok(listing.stopped, "app data that can't be listed holds everything too")
    } finally {
      await chmod(locked, 0o755)
      await rm(locked, { recursive: true })
    }
  }

  // A crash between the trash and the delete: the file is in one folder or the other, never lost, and goes a day later.
  {
    // A file back from the trash has a new change time, so a grace of its own.
    await sleep(GRACE + 50)
    await assert.rejects(sweeper().pass(control, { sweep: true, onTrashed: () => { throw new Error("killed") } }), /killed/)
    const loose = [orphan, otherSite, young, liveOrphan, stagedOrphan]
    assert.equal(loose.filter(trashed).length, 1, "the process died after one move")
    assert.ok(loose.every((file) => there(file) || trashed(file)), "nothing is lost")
    const next = await sweeper().pass(control, { sweep: true })
    assert.ok(loose.every(trashed), "the next pass goes on from what it finds")
    assert.equal(Object.values(next.folders).reduce((total, folder) => total + folder.deleted.files, 0), 0, "a file whose trashing the crash kept from the state waits its full day")
    ahead = DAY + 1
    const later = await sweeper().pass(control, { sweep: true })
    assert.equal(Object.values(later.folders).reduce((total, folder) => total + folder.deleted.files, 0), loose.length)
    assert.ok(loose.every((file) => !trashed(file) && !there(file)), "a day later they are deleted")
    for (const file of [...named, reused, liveNamed, stagedNamed, stagedHeld, stagedHashed]) assert.ok(there(file), `${file.label} still stays`)
    ahead = 0
  }

  // Undo: a file in the trash goes back on demand.
  {
    const extra = await write("trashed then restored by hand", live, "0f6c2b7e-0000-4000-8000-00000000000c-x.png")
    await sleep(GRACE + 50)
    await sweeper().pass(control, { sweep: true })
    assert.ok(trashed(extra))
    assert.equal(await sweeper().restoreAll(), 1)
    assert.ok(there(extra) && !trashed(extra))
    await rm(extra.path)
  }

  // A newer build's sweep format: this build reports and sweeps nothing.
  {
    const statePath = join(shared, "attachment-sweep.json")
    const state = JSON.parse(await readFile(statePath, "utf8"))
    await writeFile(statePath, JSON.stringify({ ...state, version: 2, newerField: 1 }))
    const stray = await write("left for a newer build")
    await sleep(GRACE + 50)
    const report = await sweeper().pass(control, { sweep: true })
    assert.match(report.stopped ?? "", /newer Mako/)
    assert.ok(there(stray), "nothing swept")
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).newerField, 1, "the newer build's state is left as it was")
    await writeFile(statePath, JSON.stringify(state))
    await rm(stray.path)
  }

  // A session whose transcript carried an attachment's bytes, the attachment reclaimed: a restore writes the session's own copy back.
  {
    const home = join(root, "harness-home")
    const records = join(root, "records")
    const session = join(home, "sessions", "s1.jsonl")
    await mkdir(join(home, "sessions"), { recursive: true })
    await writeFile(session, `{"n":1}\n`)
    const carriedAsset = await write("carried beside a transcript")
    const folder = join(home, "Library", "Application Support", "mako", "conversations", "context", "4f2a")
    await mkdir(join(folder, "attachments"), { recursive: true })
    await writeFile(join(folder, "transcript.md"), "# Transcript\n\n### Attachment\n→ attachments/turn1-1-image\n")
    await writeFile(join(folder, "attachments", "turn1-1-image"), carriedAsset.bytes)
    await noteCarried(records, "synthetic", "s1", folder)
    const store = new RecordStore(join(records, "store"), new NativeStores(false))
    const capture = new RecordCapture(store, async () => ({ roots: [{ name: "synthetic", path: home }], files: [session], databases: [] }), { home, carried: records, stampOf: () => "native" })
    assert.equal((await capture.backfill({ harness: "synthetic", nativeId: "s1", path: session })).kind, "captured")
    await sleep(GRACE + 50)
    await sweeper().pass(control, { sweep: true })
    ahead = DAY + 1
    await sweeper().pass(control, { sweep: true })
    ahead = 0
    assert.ok(!there(carriedAsset) && !trashed(carriedAsset), "named by no reader, the attachment was reclaimed")
    await rm(folder, { recursive: true })
    const elsewhere = join(root, "restored-home")
    const restored = await store.restore({ harness: "synthetic", nativeId: "s1", home: elsewhere })
    assert.ok(restored.written, JSON.stringify(restored.diverged))
    const back = await readFile(join(elsewhere, relative(home, folder), "attachments", "turn1-1-image"))
    assert.equal(createHash("sha256").update(back).digest("hex"), carriedAsset.digest, "the restore wrote the session's own copy, byte for byte")
    await capture.stop()
    await store.close()
  }

  // The catalog worker's backfill sweeps once its pass ends, after the archive's migration, and keeps the sweep in its progress.
  {
    const logs = []
    const records = join(root, "catalog-records")
    const fresh = await write("written just now")
    const catalog = new SessionCatalog([], { archivePath: archive, recordsPath: records, viewsPath: views, backfill: true, attachmentReaders: async () => readers, log: (text, fields) => logs.push({ text, fields }) })
    await catalog.scan()
    catalog.startWatching()
    const deadline = Date.now() + 10_000
    while (!catalog.backfillProgress?.endedAt && Date.now() < deadline) await sleep(20)
    const swept = catalog.backfillProgress?.assets
    await catalog.stop()
    assert.ok(swept?.ran, `the pass swept: ${JSON.stringify(catalog.backfillProgress)}`)
    assert.ok(swept.named >= named.length + 3, "the archive's rows, the journals, the view and the drafts are read through the catalog's own wiring")
    assert.equal(swept.young, 1, "within an hour of being written, a file nobody names waits")
    assert.ok(there(fresh))
    await rm(fresh.path)
  }

  for (const folder of [trash, `${live}-trash`, `${staged}-trash`]) assert.deepEqual(existsSync(folder) ? await readdir(folder) : [], [], `${folder} ends empty`)
  console.log("attachment-sweep: ok")
} finally {
  await rm(root, { recursive: true, force: true })
}

/** A LevelDB log holding one write batch of `puts`, in one record. */
function leveldbLog(puts) {
  const batch = Buffer.concat([Buffer.alloc(8), u32(puts.length), ...puts.flatMap(([key, value]) => [Buffer.from([1]), varint(key.length), key, varint(value.length), value])])
  const header = Buffer.alloc(7)
  header.writeUInt16LE(batch.length, 4)
  header[6] = 1
  return Buffer.concat([header, batch])
}

/** A LevelDB table of one data block holding `key` = `value`, Snappy-compressed with a literal and a copy. */
function leveldbTable(key, value) {
  const internal = Buffer.concat([key, Buffer.alloc(8)])
  const entry = Buffer.concat([varint(0), varint(internal.length), varint(value.length + 8), internal, value, Buffer.from("abababab")])
  const contents = Buffer.concat([entry, u32(0), u32(1)])
  // The entry up to its first "ab", then a copy of those two bytes three times over (offset 2, length 6), then the restarts.
  const head = contents.subarray(0, entry.length - 6)
  const restarts = contents.subarray(entry.length)
  const compressed = Buffer.concat([varint(contents.length), snappyLiteral(head), Buffer.from([((6 - 4) << 2) | 1, 2]), snappyLiteral(restarts)])
  assert.deepEqual(snappyDecompress(compressed), contents)
  const data = Buffer.concat([compressed, Buffer.from([1]), u32(0)])
  const handle = Buffer.concat([varint(0), varint(compressed.length)])
  const indexContents = Buffer.concat([varint(0), varint(1), varint(handle.length), Buffer.from("z"), handle, u32(0), u32(1)])
  const index = Buffer.concat([indexContents, Buffer.from([0]), u32(0)])
  const metaContents = u32(0)
  const meta = Buffer.concat([metaContents, Buffer.from([0]), u32(0)])
  const metaAt = data.length + index.length
  const handles = Buffer.concat([varint(metaAt), varint(metaContents.length), varint(data.length), varint(indexContents.length)])
  const footer = Buffer.concat([handles, Buffer.alloc(40 - handles.length), Buffer.from("57fb808b247547db", "hex")])
  return Buffer.concat([data, index, meta, footer])
}

/** A Snappy block that is one literal: what Firefox stores for a short value. */
function snappyLiteralBlock(bytes) {
  return Buffer.concat([varint(bytes.length), snappyLiteral(bytes)])
}

function snappyLiteral(bytes) {
  const length = bytes.length - 1
  return length < 60 ? Buffer.concat([Buffer.from([length << 2]), bytes]) : Buffer.concat([Buffer.from([61 << 2]), Buffer.from([length & 0xff, length >> 8]), bytes])
}

function varint(value) {
  const bytes = []
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80)
    value = Math.floor(value / 128)
  }
  bytes.push(value)
  return Buffer.from(bytes)
}

function u32(value) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return bytes
}

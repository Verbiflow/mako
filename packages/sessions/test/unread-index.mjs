import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SessionCatalog } from "../dist/catalog.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { UNREAD_INDEX_FILE, UnreadIndex, unreadCounts } from "../dist/unread-index.js"

/**
 * Unread records counted by harness version: a saved reader's `unread`
 * entries are noted as their view is written, in memory or on disk, and
 * counted with the version the record store says wrote each record's bytes.
 */

const stores = new NativeStores(false)
const root = await mkdtemp(join(tmpdir(), "mako-unread-index-"))
try {
  const home = join(root, "home")
  const project = join(home, ".claude", "projects", "-work")
  await mkdir(project, { recursive: true })
  const id = "6676d8e9-0576-43d4-9858-31fe4b22cd21"
  const path = join(project, `${id}.jsonl`)
  let parent = null
  const line = (version, type, extra = {}) => {
    const uuid = crypto.randomUUID()
    const text = `${JSON.stringify({ parentUuid: parent, isSidechain: false, userType: "external", cwd: "/work", sessionId: id, version, type, uuid, timestamp: new Date().toISOString(), ...extra })}\n`
    parent = uuid
    return text
  }
  await writeFile(path,
    line("2.1.200", "user", { message: { role: "user", content: "first" } }) +
    line("2.1.200", "mystery-record", { detail: "a kind no reader knows" }) +
    line("2.1.200", "assistant", { message: { id: "m1", role: "assistant", model: "claude-x", content: [{ type: "text", text: "ok" }] } }))
  const recordsPath = join(root, "records")
  const viewsPath = join(root, "views")
  const catalog = new SessionCatalog([new ClaudeProvider(home, stores)], { recordsPath, viewsPath, recordsHome: home })
  await catalog.scan()
  const opened = await catalog.open(path, false)
  assert.ok(opened?.entries.some((entry) => entry.type === "unread" && entry.kind === "record mystery-record"), "the reader keeps the record it doesn't know as an unread entry")
  assert.equal(await catalog.hold(path), true, "the store takes the session")

  const first = unreadCounts({ views: viewsPath, records: recordsPath })
  assert.equal(first.records, 1)
  assert.equal(first.unattributed, 0)
  assert.deepEqual(first.groups.map(({ newest, ...group }) => group), [{ harness: "claude", version: "2.1.200", source: "record", kind: "record mystery-record", reason: "unknown", count: 1, sessions: 1 }])
  assert.equal(first.groups[0].newest.path, path)
  const original = await catalog.original(path, first.groups[0].newest.id)
  assert.match(original.parts[0].text, /mystery-record/, "the newest example opens its bytes, as Show original does")

  // Claude Code updated mid-session: the new record is counted under the version that wrote it.
  await appendFile(path, line("2.1.283", "mystery-record", { detail: "again" }) + line("2.1.283", "other-mystery"))
  await catalog.scan({ emitChanges: true })
  await catalog.open(path, false)
  assert.equal(await catalog.hold(path), true)
  const second = unreadCounts({ views: viewsPath, records: recordsPath })
  assert.deepEqual(second.groups.map((group) => [group.version, group.kind, group.count]), [
    ["2.1.283", "record mystery-record", 1],
    ["2.1.283", "record other-mystery", 1],
    ["2.1.200", "record mystery-record", 1],
  ])
  assert.equal(second.records, 3)

  // Without the record store, records are counted, their version unnamed.
  const bare = unreadCounts({ views: viewsPath })
  assert.equal(bare.unattributed, 3)
  assert.ok(bare.groups.every((group) => group.version === null))
  await catalog.stop()

  // A new decoder build: the backfill's pass decodes again every session an earlier build noted, before anyone opens it.
  const indexFile = () => new DatabaseSync(join(viewsPath, UNREAD_INDEX_FILE), { readOnly: true })
  const builds = () => {
    const db = indexFile()
    try {
      return db.prepare("SELECT DISTINCT translator FROM unread").all().map((row) => row.translator)
    } finally {
      db.close()
    }
  }
  assert.equal(builds().length, 1)
  const logged = []
  const updated = new SessionCatalog([new ClaudeProvider(home, stores)], { recordsPath, viewsPath, recordsHome: home, backfill: true, translator: "a-newer-build", log: (message, fields) => logged.push([message, fields]) })
  await updated.scan()
  updated.startWatching()
  const deadline = Date.now() + 20_000
  while (!updated.backfillProgress?.endedAt && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(updated.backfillProgress?.views && { stale: updated.backfillProgress.views.stale, rebuilt: updated.backfillProgress.views.rebuilt }, { stale: 1, rebuilt: 1 }, "the session an earlier build decoded is decoded again in the background")
  assert.deepEqual(builds(), ["a-newer-build"], "and its unread records are this build's")
  assert.ok(logged.some(([message]) => message === "Session views rebuilt by this decoder build"))
  await updated.stop()

  // A newer Mako's index is left as it is; this build keeps its counts in memory instead.
  const newer = join(root, "newer")
  await mkdir(newer, { recursive: true })
  const db = new DatabaseSync(join(newer, UNREAD_INDEX_FILE))
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID; INSERT INTO meta VALUES ('schema', '9'), ('reads', '9')")
  db.close()
  const index = new UnreadIndex(join(newer, UNREAD_INDEX_FILE))
  index.note({ path: "p", harness: "grok", nativeId: "n" }, "t", [{ type: "unread", kind: "k", reason: "unknown", id: "e" }])
  assert.deepEqual(index.rows(), [], "nothing written into a newer format")
  index.close()
  const kept = new DatabaseSync(join(newer, UNREAD_INDEX_FILE))
  assert.equal(kept.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, "9")
  kept.close()
  console.log("unread index: noted as views are written, counted by the version that wrote each record, opened by id")
} finally {
  await rm(root, { recursive: true, force: true })
}

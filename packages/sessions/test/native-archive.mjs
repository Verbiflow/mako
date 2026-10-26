import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { SessionCatalog } from "../dist/catalog.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { OpenCodeProvider } from "../dist/providers/opencode.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { persistThreadAttachments } from "../dist/attachment-storage.js"
import { keepCopies } from "./fixtures/archive-copies.mjs"

const nativeStores = new NativeStores(false)

const home = await mkdtemp(join(tmpdir(), "mako-native-archive-"))
try {
  // Codex's archive moves the rollout into archived_sessions, filename kept
  // and date folders flattened, and points state_5.sqlite at it.
  const id = "01a0e74f-b716-77a2-8b46-71174540cd62"
  const name = `rollout-2026-09-28T02-19-16-${id}.jsonl`
  const dated = join(home, ".codex", "sessions", "2026", "09", "28")
  const archivedDir = join(home, ".codex", "archived_sessions")
  const live = join(dated, name)
  const archived = join(archivedDir, name)
  await mkdir(dated, { recursive: true })
  await mkdir(archivedDir, { recursive: true })
  const line = (type, payload) => `${JSON.stringify({ timestamp: "2026-09-28T09:19:16Z", type, payload })}\n`
  await writeFile(live, line("session_meta", { id, cwd: home }) + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the login redirect" }] }))
  const state = new DatabaseSync(join(home, ".codex", "state_5.sqlite"))
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, updated_at_ms INTEGER, thread_source TEXT, rollout_path TEXT)")
  state.prepare("INSERT INTO threads VALUES (?, NULL, 'Fix the login redirect', ?, ?, 'user', ?)").run(id, home, Date.now(), live)
  // The record store keeps the session's records while it's where it was.
  const recorded = { recordsPath: join(home, "mako-records"), recordsHome: home, readBack: { readers: [(stores, place) => new CodexProvider(stores, place?.home ?? home)], stores: nativeStores } }
  const first = new SessionCatalog([new CodexProvider(nativeStores, home)], recorded)
  const [open] = await first.scan()
  assert.equal(open.path, live)
  assert.equal(open.nativeArchived, undefined)
  assert.equal(await first.hold(live), true)
  await first.stop()

  const catalog = new SessionCatalog([new CodexProvider(nativeStores, home)], recorded)
  const events = []
  catalog.onEvent((event) => events.push(event))
  await catalog.scan()
  await rename(live, archived)
  state.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(archived, id)
  await catalog.scan({ emitChanges: true })
  const arrived = events.find((event) => event.type !== "removed" && event.ref.path === archived)
  assert.equal(arrived?.ref.nativeArchived, true, "the rollout in archived_sessions is listed, archived in Codex")
  assert.equal(arrived?.ref.archived, undefined, "archived in Codex is not lost")
  assert.match(arrived.ref.nativeArchiveStamp ?? "", /^\d+$/, "the archive carries its rollout's mtime")
  assert.match(arrived.ref.resumeUnavailable ?? "", /new Codex session/, "a reply continues it in a new session and leaves Codex's archive alone")
  assert.equal(open.resumeUnavailable, undefined)
  const left = events.find((event) => event.type === "removed" || event.ref.path === live)
  assert.equal(left?.type, "removed", "the old path of a session Codex only moved is removed, though Mako keeps its records")
  let listed = catalog.list()
  assert.equal(listed.length, 1, "one session, one row")
  assert.equal(listed[0].path, archived, "the native record beats Mako's copy")

  // Unarchiving moves it back to its dated folder.
  events.length = 0
  await rename(archived, live)
  state.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(live, id)
  await catalog.scan({ emitChanges: true })
  const back = events.find((event) => event.type !== "removed" && event.ref.path === live)
  assert.equal(back?.ref.nativeArchived, undefined, "unarchived, it is out again")
  assert.equal(back.ref.archived, undefined)
  assert.equal(back.ref.resumeUnavailable, undefined, "and resumes in place")
  assert.deepEqual(events.filter((event) => event.type === "removed").map((event) => event.path), [archived])
  listed = catalog.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].path, live)

  // Deleted in Codex: the row stays, read back from its records, live as after a reload.
  events.length = 0
  await rm(live)
  await catalog.scan({ emitChanges: true })
  assert.deepEqual(events.map((event) => [event.type, event.ref?.archived]), [["updated", true]])
  assert.equal(catalog.list()[0].archived, true)
  await catalog.stop()
  state.close()

  // A record with no saved copy is still simply removed.
  const bare = join(home, "bare")
  const bareDated = join(bare, ".codex", "sessions", "2026", "09", "28")
  await mkdir(bareDated, { recursive: true })
  await writeFile(join(bareDated, name), line("session_meta", { id, cwd: home }))
  const plain = new SessionCatalog([new CodexProvider(nativeStores, bare)], { archivePath: join(bare, "mako-archive") })
  const plainEvents = []
  plain.onEvent((event) => plainEvents.push(event))
  await plain.scan()
  await rm(join(bareDated, name))
  await plain.scan({ emitChanges: true })
  assert.deepEqual(plainEvents.map((event) => event.type), ["removed"])
  await plain.stop()
  console.log("Native archive: a Codex rollout archived and unarchived follows its file both ways; a deleted one whose records Mako keeps stays")

  // Moved by its harness before a capture followed it, then deleted there. The record store's row of the session is
  // the one a capture last saw, at its old path; under load the test above met that order (Codex archived the rollout,
  // a capture took the archive, Codex unarchived it and deleted it before the next capture ran) and the session was
  // announced removed while a reload listed it at the archive. The catalog finds the store's row by the session, so
  // the session stays where it was deleted from, now and after a restart. Mako closed while the harness moved it
  // leaves the same order every time.
  const movedThenDeleted = async (label, { provider, reader, from, to, write, move }) => {
    const root = join(home, "moved", label)
    const recordedHere = { recordsPath: join(root, "records"), recordsHome: root, readBack: { readers: [reader], stores: nativeStores } }
    const there = { from: from(root), to: to(root) }
    await write(root, there.from)
    const holding = new SessionCatalog([provider(root)], recordedHere)
    await holding.scan()
    assert.equal(await holding.hold(there.from), true, `${label}: held where it was`)
    await holding.stop()
    await move(root, there.from, there.to)
    const moved = new SessionCatalog([provider(root)], recordedHere)
    const heard = []
    moved.onEvent((event) => heard.push(event))
    assert.deepEqual((await moved.scan()).map((ref) => ref.path), [there.to], `${label}: listed where its harness moved it`)
    await rm(there.to)
    await moved.scan({ emitChanges: true })
    assert.deepEqual(heard.map((event) => [event.type, event.ref?.path ?? event.path, event.ref?.archived]), [["updated", there.to, true]], `${label}: deleted after a move, it stays where it was deleted from`)
    assert.deepEqual(moved.list().map((ref) => [ref.path, ref.archived]), [[there.to, true]], `${label}: and is listed there`)
    const read = await moved.open(there.to)
    assert.ok(read?.entries.some((entry) => entry.type === "user" && entry.text === "Fix the login redirect"), `${label}: read back from its records`)
    await moved.stop()
    const reloaded = new SessionCatalog([provider(root)], recordedHere)
    assert.deepEqual((await reloaded.scan()).map((ref) => [ref.path, ref.archived]), [[there.to, true]], `${label}: a restart lists it there too`)
    // Its records put it back where a capture last read it, and its harness lists it there.
    const back = await reloaded.restoreKept(there.to)
    assert.deepEqual([back.kind, back.path], ["restored", there.from], `${label}: restored to resume: ${JSON.stringify(back)}`)
    assert.deepEqual(reloaded.list().map((ref) => [ref.path, ref.archived]), [[there.from, undefined]], `${label}: one row, its harness's`)
    await reloaded.stop()
  }
  await movedThenDeleted("codex", {
    provider: (root) => new CodexProvider(nativeStores, root),
    reader: (stores, place) => new CodexProvider(stores, place?.home ?? home),
    from: (root) => join(root, ".codex", "sessions", "2026", "09", "28", name),
    to: (root) => join(root, ".codex", "archived_sessions", name),
    write: async (root, path) => {
      await mkdir(join(root, ".codex", "sessions", "2026", "09", "28"), { recursive: true })
      await writeFile(path, line("session_meta", { id, cwd: home }) + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the login redirect" }] }))
    },
    move: async (root, from, to) => {
      await mkdir(join(root, ".codex", "archived_sessions"), { recursive: true })
      await rename(from, to)
    },
  })
  // Claude Code files a session under the folder it works in: entering a worktree moves it to that project's folder.
  const claudeId = "62362b25-2460-43e5-9cff-390f9712d579"
  await movedThenDeleted("claude", {
    provider: (root) => new ClaudeProvider(root),
    reader: (_stores, place) => new ClaudeProvider(place?.home ?? home),
    from: (root) => join(root, ".claude", "projects", "-repo", `${claudeId}.jsonl`),
    to: (root) => join(root, ".claude", "projects", "-repo-worktree", `${claudeId}.jsonl`),
    write: async (root, path) => {
      await mkdir(join(root, ".claude", "projects", "-repo"), { recursive: true })
      await writeFile(path, `${JSON.stringify({ type: "user", sessionId: claudeId, uuid: "u1", timestamp: "2026-09-28T09:19:16Z", cwd: home, message: { role: "user", content: "Fix the login redirect" } })}\n`)
    },
    move: async (root, from, to) => {
      await mkdir(join(root, ".claude", "projects", "-repo-worktree"), { recursive: true })
      await rename(from, to)
    },
  })
  console.log("Native archive: a session its harness moved before a capture followed it (a Codex archive, a Claude Code worktree) and then deleted stays where it was deleted from, now and after a restart")

  // Each Codex archive is its own, even one made while Mako was closed over
  // a cached row, and a rewrite doesn't make a new one. Codex 0.154 sets the
  // rollout's mtime when it unarchives, keeps it when it archives, and keeps
  // it when `migrate-rollouts --apply` writes the file anew.
  const again = join(home, "again")
  const againDated = join(again, ".codex", "sessions", "2026", "09", "28")
  const againArchived = join(again, ".codex", "archived_sessions")
  await mkdir(againDated, { recursive: true })
  await mkdir(againArchived, { recursive: true })
  await writeFile(join(againArchived, name), line("session_meta", { id, cwd: home }))
  const cachePath = join(again, "catalog-cache.json")
  const before = new SessionCatalog([new CodexProvider(nativeStores, again)], { cachePath })
  const [firstArchive] = await before.scan()
  assert.equal(firstArchive.nativeArchived, true)
  assert.match(firstArchive.nativeArchiveStamp ?? "", /^\d+$/)
  await before.stop()
  const archivedRollout = join(againArchived, name)
  const migrated = `${archivedRollout}.migrating`
  const kept = await stat(archivedRollout)
  await writeFile(migrated, `${await readFile(archivedRollout, "utf8")}${line("event_msg", { type: "history_mode", mode: "paginated" })}`)
  await utimes(migrated, kept.atimeMs / 1000, kept.mtimeMs / 1000)
  await rename(migrated, archivedRollout)
  const rewritten = new SessionCatalog([new CodexProvider(nativeStores, again)], { cachePath })
  const [sameArchive] = await rewritten.scan()
  assert.notEqual(sameArchive.bytes, firstArchive.bytes)
  assert.equal(sameArchive.nativeArchiveStamp, firstArchive.nativeArchiveStamp, "a rollout rewritten in its archive is still that archive")
  await rewritten.stop()
  await delay(20)
  await rename(archivedRollout, join(againDated, name))
  const unarchivedAt = new Date()
  await utimes(join(againDated, name), unarchivedAt, unarchivedAt)
  await rename(join(againDated, name), archivedRollout)
  const after = new SessionCatalog([new CodexProvider(nativeStores, again)], { cachePath })
  const [secondArchive] = await after.scan()
  assert.equal(secondArchive.path, firstArchive.path)
  assert.equal(secondArchive.nativeArchived, true)
  assert.notEqual(secondArchive.nativeArchiveStamp, sameArchive.nativeArchiveStamp, "unarchived and archived again while Mako was closed is a new archive")
  assert.equal(Number(secondArchive.nativeArchiveStamp) > Number(sameArchive.nativeArchiveStamp), true)
  await after.stop()
  console.log("Native archive: a Codex rollout rewritten in its archive keeps its archive; one archived again while Mako was closed is a new archive")

  // The first archive on a machine makes archived_sessions. The watcher
  // hears the folder appear rather than waiting for the discovery sweep.
  const fresh = join(home, "fresh")
  const freshDated = join(fresh, ".codex", "sessions", "2026", "09", "28")
  const freshArchived = join(fresh, ".codex", "archived_sessions")
  await mkdir(freshDated, { recursive: true })
  await writeFile(join(freshDated, name), line("session_meta", { id, cwd: home }))
  const watched = new SessionCatalog([new CodexProvider(nativeStores, fresh)])
  const watchedEvents = []
  watched.onEvent((event) => watchedEvents.push(event))
  await watched.scan()
  watched.startWatching()
  await delay(200)
  const movedAt = Date.now()
  await mkdir(freshArchived)
  await rename(join(freshDated, name), join(freshArchived, name))
  while (!watchedEvents.some((event) => event.type !== "removed" && event.ref.path === join(freshArchived, name)) && Date.now() - movedAt < 5000) await delay(25)
  const heardIn = Date.now() - movedAt
  assert.ok(heardIn < 5000, `the first archive is heard in ${heardIn} ms, not at the 30 s sweep`)
  await watched.stop()
  console.log(`Native archive: the first archive, which creates archived_sessions, is heard in ${heardIn} ms`)

  // OpenCode's archive leaves the row intact; the session resumes as it is.
  const openRoot = join(home, ".local", "share", "opencode")
  await mkdir(openRoot, { recursive: true })
  const openDb = new DatabaseSync(join(openRoot, "opencode.db"))
  openDb.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    INSERT INTO project VALUES ('p', '/repo', 'repo', 1, 1);
    INSERT INTO session VALUES ('ses_a', 'p', NULL, '/repo', 'Refactor the parser', 1000, 2000, NULL);
  `)
  const openCatalog = new SessionCatalog([new OpenCodeProvider(nativeStores, home, {})])
  const openEvents = []
  openCatalog.onEvent((event) => openEvents.push(event))
  const [session] = await openCatalog.scan()
  assert.equal(session.nativeArchived, undefined)
  openDb.exec("UPDATE session SET time_archived = 3000 WHERE id = 'ses_a'")
  await openCatalog.scan({ emitChanges: true })
  const openArchived = openEvents.find((event) => event.type === "updated")?.ref
  assert.equal(openArchived?.nativeArchived, true, "archiving without touching time_updated still reaches the row")
  assert.equal(openArchived.archived, undefined, "archived in OpenCode is not lost")
  assert.equal(openArchived.nativeArchiveStamp, "3000", "the archive carries time_archived")
  assert.equal(openArchived.resumeUnavailable, undefined, "OpenCode goes on in an archived session, which stays archived")
  openDb.exec("UPDATE session SET time_archived = NULL WHERE id = 'ses_a'")
  await openCatalog.scan({ emitChanges: true })
  assert.equal(openEvents.at(-1)?.ref?.nativeArchived, undefined)
  assert.equal(openEvents.at(-1)?.ref?.nativeArchiveStamp, undefined)
  openDb.exec("UPDATE session SET time_archived = 4000 WHERE id = 'ses_a'")
  await openCatalog.scan({ emitChanges: true })
  assert.equal(openEvents.at(-1)?.ref?.nativeArchiveStamp, "4000", "archived again, it's a new archive")
  openDb.exec("UPDATE session SET title = 'Parser refactor' WHERE id = 'ses_a'")
  await openCatalog.scan({ emitChanges: true })
  assert.equal(openEvents.at(-1)?.ref?.title, "Parser refactor", "a rename without touching time_updated reaches the row too")
  await openCatalog.stop()
  openDb.close()
  console.log("Native archive: an OpenCode archive marks the row archived there, still resumable, each archive stamped with its time")

  // Retirement needs more than an archive flag: saved legacy contents must
  // open after a restart without either the native store or its reader.
  const legacyAsset = join(openRoot, "legacy-proof.md")
  const legacyBytes = Buffer.from("# Retained legacy attachment\nOriginal bytes survive retirement.\n")
  await writeFile(legacyAsset, legacyBytes)
  const legacyDbPath = join(openRoot, "opencode.db")
  const legacyDb = new DatabaseSync(legacyDbPath)
  const insertMessage = legacyDb.prepare("INSERT INTO message VALUES (?, 'ses_a', ?, ?, ?)")
  const insertPart = legacyDb.prepare("INSERT INTO part VALUES (?, ?, 'ses_a', ?, ?, ?)")
  insertMessage.run("legacy_user", 1000, 1000, JSON.stringify({ role: "user", time: { created: 1000 } }))
  insertPart.run("legacy_question", "legacy_user", 1000, 1000, JSON.stringify({ type: "text", text: "Read the retained document" }))
  insertPart.run("legacy_file", "legacy_user", 1001, 1001, JSON.stringify({ type: "file", filename: "legacy-proof.md", mime: "text/markdown", url: pathToFileURL(legacyAsset).href }))
  insertMessage.run("legacy_assistant", 2000, 2000, JSON.stringify({ role: "assistant", time: { created: 2000, completed: 2500 }, error: { name: "MessageAbortedError", data: { message: "Interrupted" } } }))
  insertPart.run("legacy_answer", "legacy_assistant", 2000, 2000, JSON.stringify({ type: "text", text: "The original document is retained." }))
  legacyDb.close()
  const legacyArchive = join(home, "opencode-legacy-archive")
  const capturing = new SessionCatalog([new OpenCodeProvider(nativeStores, home, {})])
  const [legacyRef] = await capturing.scan()
  const original = await capturing.open(legacyRef.path)
  assert.equal(original.entries[0].text, "Read the retained document")
  assert.ok(original.entries.some((entry) => entry.type === "text" && entry.text === "The original document is retained."))
  const nativeMarker = original.entries.find((entry) => entry.type === "event")
  assert.deepEqual(nativeMarker.source, { harness: "opencode", record: "legacy_assistant" })
  await capturing.stop()
  // The copy an earlier build kept of it, its attachment's bytes saved beside it as that build saved them.
  await keepCopies(legacyArchive, [await persistThreadAttachments(original, join(legacyArchive, "assets"))])
  await rm(legacyDbPath)
  await rm(legacyAsset)
  const readerless = new SessionCatalog([], { archivePath: legacyArchive })
  try {
    const [savedRef] = await readerless.scan()
    assert.equal(savedRef.archived, true)
    assert.equal(savedRef.nativeId, legacyRef.nativeId)
    const saved = await readerless.open(savedRef.path)
    assert.equal(saved.entries[0].text, original.entries[0].text)
    assert.deepEqual(saved.entries.slice(1), original.entries.slice(1), "answers and native marker IDs survive without any registered reader")
    const retained = saved.entries[0].attachments[0]
    assert.equal(retained.name, "legacy-proof.md")
    assert.equal(retained.mimeType, "text/markdown")
    assert.equal(retained.source.kind, "file")
    assert.notEqual(retained.source.path, legacyAsset)
    assert.deepEqual(await readFile(retained.source.path), legacyBytes)
    const page = await readerless.page(savedRef.path, undefined, 1)
    assert.equal(page.total, saved.entries.length)
    assert.equal(page.hasEarlier, true)
  } finally {
    await readerless.stop()
  }
  console.log("Native archive: legacy OpenCode prompts, replies, marker IDs and attachment bytes remain readable and pageable after store removal and a restart with no native readers")

  // Cursor's Archive sets a header flag and moves no timestamp.
  const cursorRoot = join(home, process.platform === "darwin" ? "Library/Application Support/Cursor/User/globalStorage" : ".config/Cursor/User/globalStorage")
  await mkdir(cursorRoot, { recursive: true })
  const cursorDb = new DatabaseSync(join(cursorRoot, "state.vscdb"))
  cursorDb.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT); CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)")
  const composer = "12345678-1234-1234-1234-123456789abc"
  const header = { composerId: composer, name: "Architecture review", createdAt: 1700000000000, lastUpdatedAt: 1700000001000, workspaceIdentifier: { uri: { fsPath: home } } }
  cursorDb.prepare("INSERT INTO composerHeaders (composerId, lastUpdatedAt, isArchived, isSubagent, checkpointAt, value) VALUES (?, ?, 0, 0, 1, ?)").run(composer, header.lastUpdatedAt, JSON.stringify(header))
  const cursor = new CursorProvider(nativeStores, home, {})
  const [desk] = await cursor.discover()
  assert.equal((await cursor.peek(desk)).nativeArchived, undefined)
  cursorDb.exec("UPDATE composerHeaders SET isArchived = 1")
  const [flagged] = await cursor.discover()
  assert.notEqual(flagged.revision, desk.revision, "the stamp moves when only the archive flag does")
  const flaggedRef = await cursor.peek(flagged)
  assert.equal(flaggedRef.nativeArchived, true)
  assert.equal(flaggedRef.archived, undefined)
  // A rename rewrites the header's value and nothing else; so does one that
  // keeps the name's length, which the fingerprint can't see.
  const renameTo = (name) => cursorDb.prepare("UPDATE composerHeaders SET value = ?").run(JSON.stringify({ ...header, name }))
  renameTo("Architecture notes")
  const [renamed] = await cursor.discover()
  assert.notEqual(renamed.revision, flagged.revision, "a rename moves the stamp")
  assert.equal((await cursor.peek(renamed)).title, "Architecture notes")
  renameTo("Architecture plans")
  const realNow = Date.now
  Date.now = () => realNow() + 31_000
  try {
    const [sameLength] = await cursor.discover()
    assert.notEqual(sameLength.revision, renamed.revision, "a same-length rename is caught once the fingerprint stops answering")
  } finally {
    Date.now = realNow
  }
  cursorDb.close()
  console.log("Native archive: Cursor's Archive flag and renames reach the row though they move no timestamp")
} finally {
  await rm(home, { recursive: true, force: true })
}

import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { ClaudeProvider, CursorProvider, SessionCatalog, translatorOf, type SessionProvider, type ThreadPage } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { spanIds } from "@mako/host/conversations/base-source"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"

// A Thread that went on in two harnesses has a record in each, and each record's view is fingerprinted by its own
// harness's decoder (`translatorBuild(harness)`). An update that changed only Cursor's decoder keeps the Claude
// record's view and decodes the Cursor record again, and the other way round; one that changed a module both decode
// with decodes both again. Whichever records were decoded again, the Thread's history reads whole and in order: its
// first harness's record (the journal's `baseSource`, a span of it), then the turns it went on with in the other.
// The fingerprints here are the real ones, of a copy of this build's `@mako/sessions` with one module edited.

const root = mkdtempSync(join(tmpdir(), "mako-multi-harness-views-"))
const hosts: LiveConversations[] = []
try {
  const home = join(root, "home")
  const cwd = join(home, "work")
  mkdirSync(cwd, { recursive: true })
  const stores = new NativeStores(false)
  /** Turns of a record, long enough that each decode is kept on disk (`VIEW_MIN_DECODE_MS`). */
  const TURNS = 1000
  const words = (turn: number, n: number) => Array.from({ length: n }, (_, at) => `word${(turn * 31 + at) % 97}`).join(" ")

  // Claude Code's record: the Thread's first turns.
  const claudeId = "c1a0de00-0000-4000-8000-000000000001"
  const claudeFolder = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
  mkdirSync(claudeFolder, { recursive: true })
  const claudePath = join(claudeFolder, `${claudeId}.jsonl`)
  const lines: string[] = []
  for (let turn = 0; turn < TURNS; turn++) {
    const at = new Date(Date.UTC(2026, 10, 19, 0, 0, turn)).toISOString()
    lines.push(JSON.stringify({ type: "user", uuid: `cl-u${turn}`, sessionId: claudeId, cwd, timestamp: at, message: { role: "user", content: `Claude turn ${turn}: ${words(turn, 30)}` } }))
    lines.push(JSON.stringify({ type: "assistant", uuid: `cl-a${turn}`, sessionId: claudeId, cwd, timestamp: at, message: { id: `cl-m${turn}`, role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: `Claude answer ${turn}: ${words(turn, 120)}` }] } }))
  }
  writeFileSync(claudePath, lines.join("\n") + "\n")

  // cursor-agent's record: the turns the Thread went on with there, content-addressed blobs and a root naming them all.
  const agentId = "c0de0000-0000-4000-8000-000000000002"
  const cursorFolder = join(home, ".cursor", "chats", "c".repeat(32), agentId)
  mkdirSync(cursorFolder, { recursive: true })
  const cursorPath = join(cursorFolder, "store.db")
  const db = new DatabaseSync(cursorPath)
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  const insert = db.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)")
  const blob = (data: Buffer) => {
    const id = createHash("sha256").update(data).digest("hex")
    insert.run(id, data)
    return id
  }
  const messages: string[] = []
  db.exec("BEGIN")
  messages.push(blob(Buffer.from(JSON.stringify({ role: "system", content: "You are a coding agent." }))))
  for (let turn = 0; turn < TURNS; turn++) {
    messages.push(blob(Buffer.from(JSON.stringify({ role: "user", content: [{ type: "text", text: `<user_query>\nCursor turn ${turn}: ${words(turn, 30)}\n</user_query>` }] }))))
    messages.push(blob(Buffer.from(JSON.stringify({ role: "assistant", content: [{ type: "text", text: `Cursor answer ${turn}: ${words(turn, 120)}` }] }))))
  }
  const rootBlob = blob(Buffer.concat([...messages.map((id) => Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(id, "hex")])), Buffer.from([0x1a, 0x02, 0x6f, 0x6b])]))
  db.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ agentId, latestRootBlobId: rootBlob, name: "Went on in Cursor", mode: "default" })).toString("hex"))
  db.exec("COMMIT")
  db.close()
  writeFileSync(join(cursorFolder, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: 1, hasConversation: true, updatedAtMs: 1, cwd }))

  // Each harness's fingerprint, as a build of this package with `edits` made to it says (`translatorOf`).
  const dist = join(dirname(fileURLToPath(import.meta.resolve("@mako/sessions"))))
  const build = join(root, "build")
  cpSync(dist, build, { recursive: true, filter: (path) => !path.endsWith(".map") && !path.endsWith(".d.ts") })
  const fingerprints = () => {
    const taken = { claude: translatorOf(build, ".js", "claude"), cursor: translatorOf(build, ".js", "cursor") }
    return (harness: string) => (harness === "claude" || harness === "cursor" ? taken[harness] : `other-${harness}`)
  }
  const update = (module: string) => appendFileSync(join(build, module), `\n// ${module} changed\n`)

  // Every decode, by harness: a view reused is no decode.
  const decodes = { claude: 0, cursor: 0 }
  const counted = <Provider extends SessionProvider>(provider: Provider, harness: "claude" | "cursor"): Provider => {
    const read = provider.read.bind(provider)
    provider.read = async (path) => {
      decodes[harness] += 1
      return read(path)
    }
    return provider
  }
  const viewsPath = join(root, "views")
  const conversations = join(root, "conversations")
  /** A host after an update: a catalog of this build's fingerprints over the views earlier builds left, and its conversations. */
  /** Pages asked for at this build's decode (`history`), by record: a view found current is asked for its newest page alone. */
  const asked = { claude: 0, cursor: 0 }
  /** `stale`: as the app's host reads, an earlier build's view of an unchanged record first (`staleHistory`). */
  const opened = async (stale = false) => {
    const catalog = new SessionCatalog([counted(new ClaudeProvider(home, stores), "claude"), counted(new CursorProvider(stores, home), "cursor")], { viewsPath, translator: fingerprints() })
    await catalog.scan()
    const live = new LiveConversations({
      appPath: root, root: conversations, driver: () => undefined, emit: () => {},
      history: (path: string, before?: number) => {
        asked[path === claudePath ? "claude" : "cursor"] += 1
        return catalog.page(path, before)
      },
      ...stale && { staleHistory: (path: string, before?: number) => catalog.page(path, before, undefined, { stale: true }) },
      nativePath: (identity) => (identity.harness === "claude" ? claudePath : identity.harness === "cursor" ? cursorPath : undefined),
    })
    hosts.push(live)
    return { catalog, live }
  }
  /** A record read whole, as the catalog pages it. */
  const whole = async (catalog: SessionCatalog, path: string): Promise<ThreadPage> => {
    let page = (await catalog.page(path))!
    const pages = [page]
    while (page.hasEarlier) pages.unshift((page = (await catalog.page(path, page.start))!))
    return { ...pages.at(-1)!, entries: pages.flatMap((each) => each.entries), start: 0, hasEarlier: false }
  }

  // The first decode of each record, by this build.
  const first = await opened()
  const claudeRecord = await whole(first.catalog, claudePath)
  const cursorRecord = await whole(first.catalog, cursorPath)
  assert.deepEqual(decodes, { claude: 1, cursor: 1 }, "each record decodes once")
  assert.ok(claudeRecord.entries.some((entry) => entry.type === "user" && entry.text.startsWith("Claude turn 0")))
  assert.ok(cursorRecord.entries.some((entry) => entry.type === "user" && entry.text.startsWith("Cursor turn 0")))

  /**
   * A Thread that began in `from` and went on in `to`: its journal names a span of `from`'s record (all of it, as it
   * was when it moved) as its history, and holds the turns it went on with in `to` as its own blocks.
   */
  const thread = (from: ThreadPage, to: ThreadPage, onward: number): string => {
    const id = randomUUID()
    const blocks: Entry[] = to.entries.filter((entry) => entry.type === "user" || entry.type === "text").slice(0, onward)
      .map((entry) => ({ ...entry, id: `live-${entry.id}` }))
    const fromBinding = { id: randomUUID(), provider: from.ref.harness, nativeId: from.ref.nativeId, path: from.ref.path, includesBase: true, coveredBlocks: 0 }
    const toBinding = { id: randomUUID(), provider: to.ref.harness, nativeId: to.ref.nativeId, path: to.ref.path, includesBase: false, coveredBlocks: blocks.length }
    const snapshot: LiveSnapshot = {
      session: { id, harness: to.ref.harness, nativeId: to.ref.nativeId, cwd, connection: "disconnected", status: "ready", modes: [], currentMode: null, configOptions: [] },
      revision: 0, createdAt: 1, threadPath: to.ref.path, base: null, permissions: [], requests: [], blocks,
      baseSource: { harness: from.ref.harness, nativeId: from.ref.nativeId, path: from.ref.path, span: { entries: from.entries.length, ids: spanIds(from.entries), heldAt: Date.now() } },
      control: { activeBindingId: toBinding.id, transfers: [], merges: [], bindings: [fromBinding, toBinding] },
    }
    const journal = new LiveJournal(conversations, id)
    journal.commit(snapshot)
    journal.close()
    return id
  }
  const claudeThenCursor = thread(claudeRecord, cursorRecord, 6)
  const cursorThenClaude = thread(cursorRecord, claudeRecord, 6)
  await first.live.stop()
  await first.catalog.stop()

  /** What a window shows of a Thread: its first harness's history, then what it went on with, each by its words. */
  const shown = async (live: LiveConversations, id: string) => {
    const snapshot = (await live.refreshedSnapshot(id))!
    assert.ok(snapshot.base, "its history is read")
    return { translator: snapshot.base.translator, said: [...snapshot.base.entries, ...snapshot.blocks].flatMap((entry) => (entry.type === "user" || entry.type === "text" ? [entry.text.split(":")[0]!] : [])) }
  }
  const expected = (from: "Claude" | "Cursor", to: "Claude" | "Cursor") => [
    ...Array.from({ length: TURNS }, (_, turn) => [`${from} turn ${turn}`, `${from} answer ${turn}`]).flat(),
    ...Array.from({ length: 3 }, (_, turn) => [`${to} turn ${turn}`, `${to} answer ${turn}`]).flat(),
  ]
  const check = async (label: string, decoded: { claude: number; cursor: number }) => {
    const before = { ...decodes }
    const host = await opened()
    const claudeFirst = await shown(host.live, claudeThenCursor)
    const cursorFirst = await shown(host.live, cursorThenClaude)
    assert.deepEqual({ claude: decodes.claude - before.claude, cursor: decodes.cursor - before.cursor }, decoded, `${label}: decoded again ${JSON.stringify(decoded)}`)
    const now = fingerprints()
    assert.equal(claudeFirst.translator, now("claude"), `${label}: the Claude-first Thread's history is the Claude record as this build decodes it`)
    assert.equal(cursorFirst.translator, now("cursor"), `${label}: the Cursor-first Thread's history is the Cursor record as this build decodes it`)
    assert.deepEqual(claudeFirst.said, expected("Claude", "Cursor"), `${label}: Claude's turns, then Cursor's, in order`)
    assert.deepEqual(cursorFirst.said, expected("Cursor", "Claude"), `${label}: Cursor's turns, then Claude's, in order`)
    await host.live.stop()
    await host.catalog.stop()
    console.log(`PASS: ${label}: decoded again claude ${decoded.claude}, cursor ${decoded.cursor}; both Threads read whole and in order`)
  }

  await check("nothing changed", { claude: 0, cursor: 0 })
  update("providers/cursor-records.js")
  await check("only Cursor's decoder changed", { claude: 0, cursor: 1 })
  update("claude-projection.js")
  await check("only Claude's decoder changed", { claude: 1, cursor: 0 })
  update("entry-sink.js")
  await check("a module both decode with changed", { claude: 1, cursor: 1 })

  // As the app's host reads: an earlier build's view of each unchanged record answers first (`staleHistory`), so a
  // window isn't kept waiting on a decode. A refresh reads a session again only while one session holds every live
  // block, so a Thread that went on in two kept the earlier build's reading of its first record until it was read in
  // again. Now each span whose record's current view names another decoder is read again in the background, and one
  // whose record is current isn't: only its newest page is asked for.
  const waitFor = async (predicate: () => boolean, message: string) => {
    const until = Date.now() + 30_000
    while (!predicate()) {
      if (Date.now() > until) throw new Error(message)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const checkStale = async (label: string, decoded: { claude: number; cursor: number }) => {
    const before = { ...decodes }
    const pages = { ...asked }
    const host = await opened(true)
    const now = fingerprints()
    // Answered at once, from what's at hand: the window doesn't wait for the decode.
    const firstShown = { claude: (await host.live.windowSnapshot(claudeThenCursor))!, cursor: (await host.live.windowSnapshot(cursorThenClaude))! }
    for (const harness of ["claude", "cursor"] as const) {
      assert.ok(firstShown[harness].base, `${label}: the ${harness}-first Thread shows its history at once`)
      if (decoded[harness]) assert.notEqual(firstShown[harness].base.translator, now(harness), `${label}: as the earlier build read ${harness}'s record`)
    }
    const current = (id: string, harness: "claude" | "cursor") => host.live.held(id)?.base?.translator === now(harness)
    await waitFor(() => current(claudeThenCursor, "claude") && current(cursorThenClaude, "cursor"), `${label}: each span is read again by this build`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual({ claude: decodes.claude - before.claude, cursor: decodes.cursor - before.cursor }, decoded, `${label}: decoded again ${JSON.stringify(decoded)}`)
    for (const harness of ["claude", "cursor"] as const) {
      if (decoded[harness]) continue
      assert.ok(asked[harness] - pages[harness] <= 1, `${label}: ${harness}'s record, current, is asked for its newest page at most, never read whole again`)
    }
    const claudeFirst = await shown(host.live, claudeThenCursor)
    const cursorFirst = await shown(host.live, cursorThenClaude)
    assert.deepEqual(claudeFirst.said, expected("Claude", "Cursor"), `${label}: Claude's turns, then Cursor's, in order`)
    assert.deepEqual(cursorFirst.said, expected("Cursor", "Claude"), `${label}: Cursor's turns, then Claude's, in order`)
    await host.live.stop()
    await host.catalog.stop()
    console.log(`PASS: through staleHistory, ${label}: shown at once, then decoded again claude ${decoded.claude}, cursor ${decoded.cursor}`)
  }
  await checkStale("nothing changed", { claude: 0, cursor: 0 })
  update("providers/cursor-records.js")
  await checkStale("only Cursor's decoder changed", { claude: 0, cursor: 1 })
  update("claude-projection.js")
  await checkStale("only Claude's decoder changed", { claude: 1, cursor: 0 })
  update("entry-sink.js")
  await checkStale("a module both decode with changed", { claude: 1, cursor: 1 })
} finally {
  for (const live of hosts) await live.stop().catch(() => undefined)
  rmSync(root, { recursive: true, force: true })
}
console.log("multi-harness views: each record's view kept or decoded by its own harness's fingerprint; a Thread spanning both reads whole")

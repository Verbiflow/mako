import { createHash } from "node:crypto"
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { forkLines, replaceQuoted } from "../packages/sessions/src/record-fork.ts"
import type { SessionRecords } from "../packages/sessions/src/harness-records.ts"
import { RecordStore, taggedRow, type RestoreReport } from "../packages/sessions/src/record-store.ts"
import { z } from "zod"
import type { SessionProvider } from "../packages/sessions/src/providers/types.ts"
import { drawing, PAIRS_FOLDER, PairSchema, storeMessages, storeReader } from "./decode-compare.ts"
import { FIXTURE_ROOT } from "./native-decoding.ts"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

/**
 * A restore onto a destination whose copy of the session went on without
 * Mako, for every harness, on its recorded pairs (no model calls): the
 * destination's copy is left byte- and row-identical, the arriving version
 * becomes a new session of the harness's own (`SessionProvider.fork`) that
 * the harness's reader lists and draws as the arriving version draws, a
 * second restore finds that fork and writes nothing, and a fork that went
 * on there too is left as well.
 *
 * Where the session is an append-only transcript (Claude, Codex, Grok),
 * Mako captured it at half its lines and again whole, and the destination
 * holds the half and a line of its own: the fork must say the two share the
 * half. Where it is rows (OpenCode, Devin, Cursor), the destination changed
 * the session's own row.
 */

const nativeStores = new NativeStores(false)
const IndexLine = z.object({ id: z.string(), thread_name: z.string().optional() })
const ClaudeLine = z.object({ sessionId: z.string().optional(), uuid: z.string().optional(), forkedFrom: z.object({ sessionId: z.string(), messageUuid: z.string() }).optional() })
const failures: string[] = []
const PAIRS_PER_HARNESS = Number(process.env["FORK_PAIRS"] ?? Infinity)

/** How each harness's test copy of a session goes on without Mako, and where the fork's lineage shows. */
type Diverge = (home: string, records: SessionRecords, nativeId: string) => Promise<void>
const DIVERGE = new Map<string, Diverge>(Object.entries({
  opencode: async (_, records, nativeId) => updateRows(records, "UPDATE session_v2 SET title = 'went on here' WHERE id = ?", nativeId),
  devin: async (_, records, nativeId) => updateRows(records, "UPDATE sessions SET title = 'went on here' WHERE id = ?", nativeId),
  cursor: async (_, records, nativeId) => updateRows(records, "UPDATE agents SET name = 'went on here' WHERE agent_id = ?", nativeId),
} satisfies Record<string, Diverge>))

const ORDERED = new Map([["devin", { database: ".local/share/devin/cli/sessions.db", sql: "SELECT node_id AS node FROM message_nodes WHERE session_id = ? ORDER BY row_id" }]])

function updateRows(records: SessionRecords, sql: string, nativeId: string): void {
  let changed = 0
  for (const database of records.databases) {
    const db = new DatabaseSync(database.path)
    try {
      changed += Number(db.prepare(sql).run(nativeId).changes)
    } catch {
      // Not this database's table.
    } finally {
      db.close()
    }
  }
  if (!changed) throw new Error(`No row changed for ${sql}`)
}

async function scratch<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mako-forks-"))
  try {
    return await work(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Every file and owned row of a session at `home`, hashed: what a restore must leave as it is. */
async function fingerprint(records: SessionRecords): Promise<string> {
  const hash = createHash("sha256")
  for (const file of [...records.files].sort()) hash.update(file).update(await readFile(file).catch(() => Buffer.from("missing")))
  for (const database of records.databases) {
    const db = new DatabaseSync(database.path, { readOnly: true })
    try {
      for (const table of database.tables) {
        const statement = db.prepare(`SELECT * FROM "${table.table}"${table.where ? ` WHERE ${table.where}` : ""} ORDER BY 1`)
        statement.setReadBigInts(true)
        for (const row of statement.iterate(...(table.params ?? []))) hash.update(table.table).update(JSON.stringify(taggedRow({ ...row })))
      }
    } finally {
      db.close()
    }
  }
  return hash.digest("hex")
}

async function sessionAt(provider: SessionProvider, nativeId: string): Promise<string | null> {
  for (const file of await provider.discover()) if ((await provider.peek(file).catch(() => null))?.nativeId === nativeId) return file.path
  return null
}

const summary = (report: RestoreReport) => JSON.stringify({ diverged: report.diverged, kept: report.kept.length, fork: report.fork && { ...report.fork, actions: report.fork.actions.length } }).slice(0, 600)

async function forkPair(where: string, reader: string, harness: string, fixtureHome: string, relative: string): Promise<string[]> {
  const found: string[] = []
  await scratch(async (root) => {
    const source = join(root, "source")
    const destination = join(root, "destination")
    await cp(fixtureHome, source, { recursive: true })
    const sourceReader = storeReader(reader, source)
    const path = join(source, relative)
    const info = await stat(path.replace(/#.*$/, ""))
    const ref = await sourceReader.peek({ path, bytes: info.size, mtimeMs: info.mtimeMs })
    if (!ref?.nativeId) throw new Error(`${reader} names no session at ${relative}`)
    const nativeId = ref.nativeId
    const records = await sourceReader.records(path)
    if (!records) throw new Error(`${reader} keeps no records at ${relative}`)
    const transcript = DIVERGE.has(reader) ? null : path
    if (transcript && !/\.(?:jsonl|ndjson)$/.test(transcript)) throw new Error(`${relative} is neither a transcript nor a store this test diverges`)
    const store = new RecordStore(join(root, "store"), nativeStores)
    try {
      let half = 0
      let whole = Buffer.alloc(0)
      if (transcript) {
        whole = await readFile(transcript)
        for (let at = whole.indexOf(10); at !== -1 && at < whole.length / 2; at = whole.indexOf(10, at + 1)) half = at + 1
        await truncate(transcript, half)
      }
      await store.capture({ harness: reader, nativeId, home: source, records: (await sourceReader.records(path))! })
      const first = await store.restore({ harness: reader, nativeId, home: destination })
      if (!first.written || first.diverged.length) found.push(`restoring under a fresh home didn't write: ${summary(first)}`)
      const destinationReader = storeReader(reader, destination)
      const localPath = join(destination, relative)
      if (transcript) {
        await writeFile(transcript, whole)
        await store.capture({ harness: reader, nativeId, home: source, records: (await sourceReader.records(path))! })
        // The destination's own turn: a line Mako never saw, after the half it holds.
        const lines = whole.subarray(0, whole.length - 1).toString("utf8").split("\n")
        await appendFile(localPath, `${lines.at(-1)}\n`)
      } else await DIVERGE.get(reader)!(destination, (await destinationReader.records(localPath))!, nativeId)
      const localRecords = (await destinationReader.records(localPath))!
      const before = await fingerprint(localRecords)
      const fork = sourceReader.fork
      if (!fork) {
        found.push(`${reader} declares no fork`)
        return
      }

      const plain = await store.restore({ harness: reader, nativeId, home: destination, destination: localRecords })
      if (plain.written || !plain.diverged.length) found.push(`without a fork rule, a restore onto a copy that went on wrote or found nothing diverged: ${summary(plain)}`)
      const dry = await store.restore({ harness: reader, nativeId, home: destination, destination: localRecords, fork, dryRun: true })
      if (dry.written || !dry.fork || dry.fork.written) found.push(`a dry run wrote: ${summary(dry)}`)

      const forked = await store.restore({ harness: reader, nativeId, home: destination, destination: localRecords, fork })
      if (!forked.fork?.written || forked.diverged.length) {
        found.push(`the restore didn't fork: ${summary(forked)}`)
        return
      }
      if (await fingerprint(localRecords) !== before) found.push("the destination's own copy changed")
      const forkId = forked.fork.nativeId
      if (forkId === nativeId) found.push("the fork kept the session's id")
      if (transcript) {
        const shared = forked.fork.from.find((unit) => !unit.unit.includes("\t"))?.shared
        if (shared !== half) found.push(`the fork says the copies share ${shared ?? "nothing"} bytes; they share the first ${half}`)
      }
      const forkPath = await sessionAt(storeReader(reader, destination), forkId)
      if (!forkPath) {
        found.push(`${reader} lists no session ${forkId} after the fork: ${summary(forked)}`)
        return
      }
      const arriving = drawing((await storeMessages(reader, harness, source, path)).messages)
      const drawn = drawing((await storeMessages(reader, harness, destination, forkPath)).messages)
      if (!drawn.length || arriving.join("\n") !== drawn.join("\n")) found.push(`the fork draws ${drawn.length} lines unlike the arriving version's ${arriving.length}`)
      // Rows numbered by the destination keep the session's order (Devin's message nodes by `row_id`).
      const ordered = ORDERED.get(reader)
      if (ordered) {
        const nodes = (home: string, session: string) => {
          const db = new DatabaseSync(join(home, ordered.database), { readOnly: true })
          try {
            return db.prepare(ordered.sql).all(session).map((row) => String(row["node"]))
          } finally {
            db.close()
          }
        }
        if (nodes(source, nativeId).join() !== nodes(destination, forkId).join()) found.push(`the fork's ${ordered.sql} order differs from the session's`)
      }
      const forkRef = await storeReader(reader, destination).peek({ path: forkPath, bytes: (await stat(forkPath.replace(/#.*$/, ""))).size, mtimeMs: 0 })
      if (forkRef?.parentNativeId !== undefined && forkRef.parentNativeId !== nativeId) found.push(`the fork names ${forkRef.parentNativeId} as its parent`)
      if (process.env["FORK_VERBOSE"]) console.log(where, reader, nativeId, "->", forkId, "parent:", forkRef?.parentNativeId, "lines:", drawn.length, "from:", JSON.stringify(forked.fork.from), "actions:", forked.fork.actions.map((action) => `${action.action} ${action.path}`).join(", "), "rows:", forked.fork.rows.map((rows) => `${rows.table} +${rows.insert}`).join(", "))

      const again = await store.restore({ harness: reader, nativeId, home: destination, destination: localRecords, fork })
      if (again.written || again.fork?.nativeId !== forkId || again.fork.written || again.fork.diverged.length) found.push(`a second restore didn't find the fork as it was: ${summary(again)}`)
      if (await fingerprint(localRecords) !== before) found.push("a second restore changed the destination's own copy")

      // The fork went on there too: it's left, and nothing else is written.
      const forkRecords = (await storeReader(reader, destination).records(forkPath))!
      if (transcript) await appendFile(forkPath, "{\"type\":\"went-on\"}\n")
      else await DIVERGE.get(reader)!(destination, forkRecords, forkId)
      const forkBefore = await fingerprint(forkRecords)
      const onto = await store.restore({ harness: reader, nativeId, home: destination, destination: localRecords, fork })
      if (onto.written || !onto.fork?.diverged.length) found.push(`a fork that went on wasn't left: ${summary(onto)}`)
      if (await fingerprint(forkRecords) !== forkBefore) found.push("a restore changed a fork that went on")
    } finally {
      await store.close()
    }
  })
  return found.map((problem) => `${where} ${reader}: ${problem}`)
}

/** The line rewriter against a file split every way: unchanged runs stay slices, changed lines come out whole, and a last line without a newline is kept. */
async function linesCase(): Promise<string[]> {
  const found: string[] = []
  const text = Buffer.from(`{"sessionId":"a","n":1}\n{"x":2}\n\n{"sessionId":"a","n":3}\n{"tail":"a"}`)
  const expected = text.toString("utf8").split("\n").map((line, index) => replaceQuoted(Buffer.from(line), "a", `b${index}`).toString("utf8")).join("\n")
  for (let size = 1; size <= text.length; size++) {
    const chunks: Buffer[] = []
    for (let at = 0; at < text.length; at += size) chunks.push(text.subarray(at, at + size))
    const out: Buffer[] = []
    for await (const piece of forkLines(chunks, (line, index) => replaceQuoted(line, "a", `b${index}`))) out.push(piece)
    if (Buffer.concat(out).toString("utf8") !== expected) found.push(`forkLines with ${size}-byte chunks gave ${JSON.stringify(Buffer.concat(out).toString("utf8"))}`)
  }
  return found
}

/** A pair's session copied into a scratch home, with what a test adds beside it, captured, restored and gone on without Mako; then `check` sees the fork. */
async function sideRecords(
  label: string, reader: string, pair: string,
  extra: (home: string, nativeId: string, path: string) => Promise<void>,
  check: (context: { source: string; destination: string; nativeId: string; forkId: string; report: RestoreReport }) => Promise<string[]>
): Promise<string[]> {
  const folder = join(FIXTURE_ROOT, reader, PAIRS_FOLDER, pair)
  const parsed = PairSchema.parse(JSON.parse(await readFile(join(folder, "pair.json"), "utf8")))
  const relative = parsed.stores[0]!.path
  return scratch(async (root) => {
    const found: string[] = []
    const source = join(root, "source")
    const destination = join(root, "destination")
    await cp(join(folder, "home"), source, { recursive: true })
    const path = join(source, relative)
    const sourceReader = storeReader(reader, source)
    const nativeId = (await sourceReader.peek({ path, bytes: (await stat(path)).size, mtimeMs: 0 }))!.nativeId
    await extra(source, nativeId, path)
    const store = new RecordStore(join(root, "store"), nativeStores)
    try {
      await store.capture({ harness: reader, nativeId, home: source, records: (await sourceReader.records(path))! })
      await store.restore({ harness: reader, nativeId, home: destination })
      const localPath = join(destination, relative)
      await appendFile(localPath, "{\"type\":\"went-on\"}\n")
      const localRecords = (await storeReader(reader, destination).records(localPath))!
      const before = await fingerprint(localRecords)
      const fork = sourceReader.fork!
      const report = await store.restore({ harness: reader, nativeId, home: destination, destination: localRecords, fork })
      if (!report.fork?.written || report.diverged.length) return [`${label}: the restore didn't fork: ${summary(report)}`]
      if (await fingerprint(localRecords) !== before) found.push(`${label}: the destination's own copy changed`)
      found.push(...(await check({ source, destination, nativeId, forkId: report.fork.nativeId, report })).map((problem) => `${label}: ${problem}`))
      const again = await store.restore({ harness: reader, nativeId, home: destination, destination: localRecords, fork })
      if (again.written || again.fork?.diverged.length) found.push(`${label}: a second restore wrote or diverged: ${summary(again)}`)
    } finally {
      await store.close()
    }
    return found
  })
}

/** Codex's state, its name in `session_index.jsonl` and a spawned agent's edge: the fork's row points at its own rollout, its tools and name follow it, and the child stays the source's. */
async function codexSideRecords(): Promise<string[]> {
  return sideRecords("codex state and names", "codex", "read-and-answer", async (home, nativeId, path) => {
    const db = new DatabaseSync(join(home, ".codex", "state_5.sqlite"))
    try {
      db.exec(`
        CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL);
        CREATE TABLE threads (
          id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL,
          cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
          has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, git_sha TEXT, git_branch TEXT, git_origin_url TEXT,
          cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', agent_nickname TEXT, agent_role TEXT, memory_mode TEXT NOT NULL DEFAULT 'enabled',
          model TEXT, reasoning_effort TEXT, agent_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, preview TEXT NOT NULL DEFAULT '',
          recency_at INTEGER NOT NULL DEFAULT 0, recency_at_ms INTEGER NOT NULL DEFAULT 0, history_mode TEXT NOT NULL DEFAULT 'legacy', name TEXT
        );
        CREATE TABLE thread_dynamic_tools (thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, input_schema TEXT NOT NULL, PRIMARY KEY(thread_id, position));
        CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
      `)
      db.prepare("INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (1, 'threads', 1, x'00', 1)").run()
      db.prepare("INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, name, updated_at_ms) VALUES (?, ?, 1, 2, 'exec', 'openai', '/tmp', 'Notes', '{}', 'never', 'Named by Codex', 2000)").run(nativeId, path)
      db.prepare("INSERT INTO thread_dynamic_tools VALUES (?, 0, 'probe', 'A tool', '{}')").run(nativeId)
      db.prepare("INSERT INTO thread_spawn_edges VALUES (?, 'child-thread', 'closed')").run(nativeId)
    } finally {
      db.close()
    }
    await writeFile(join(home, ".codex", "session_index.jsonl"), `${JSON.stringify({ id: "another-thread", thread_name: "Other" })}\n${JSON.stringify({ id: nativeId, thread_name: "Named by Codex", updated_at: "2026-10-12T00:00:00Z" })}\n`)
  }, async ({ destination, nativeId, forkId }) => {
    const found: string[] = []
    const db = new DatabaseSync(join(destination, ".codex", "state_5.sqlite"), { readOnly: true })
    try {
      const row = db.prepare("SELECT rollout_path, name FROM threads WHERE id = ?").get(forkId)
      const path = z.string().catch("").parse(row?.["rollout_path"])
      if (!path.startsWith(destination) || !path.includes(forkId) || !(await stat(path).catch(() => null))) found.push(`the fork's thread row names ${path || "no rollout"}`)
      if (row?.["name"] !== "Named by Codex") found.push("the fork's thread row lost its name")
      if (db.prepare("SELECT count(*) AS n FROM thread_dynamic_tools WHERE thread_id = ?").get(forkId)?.["n"] !== 1) found.push("the fork's dynamic tools didn't follow it")
      const edges = db.prepare("SELECT parent_thread_id FROM thread_spawn_edges").all().map((edge) => edge["parent_thread_id"])
      if (edges.length !== 1 || edges[0] !== nativeId) found.push(`the spawned agent's edge is ${JSON.stringify(edges)}`)
      const first = (await readFile(path, "utf8")).split("\n")[0] ?? ""
      if (!first.includes(`"id":"${forkId}"`) || !first.includes(`"forked_from_id":"${nativeId}"`)) found.push(`the fork's session_meta is ${first.slice(0, 200)}`)
    } finally {
      db.close()
    }
    const names = (await readFile(join(destination, ".codex", "session_index.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => IndexLine.parse(JSON.parse(line)))
    if (!names.some((line) => line.id === forkId && line.thread_name === "Named by Codex")) found.push(`session_index.jsonl doesn't name the fork: ${JSON.stringify(names)}`)
    return found
  })
}

/** What Claude Code keeps under a session's id: a subagent's transcript naming the session, a tool result, a file snapshot and a todo list all move to the fork's id. */
async function claudeSideRecords(): Promise<string[]> {
  return sideRecords("claude side records", "claude", "read-and-answer", async (home, nativeId, path) => {
    const folder = path.slice(0, -".jsonl".length)
    await mkdir(join(folder, "subagents"), { recursive: true })
    await writeFile(join(folder, "subagents", "agent-a1.jsonl"), `${JSON.stringify({ type: "user", sessionId: nativeId, agentId: "a1", uuid: "u-1", isSidechain: true, message: { role: "user", content: "look" } })}\n`)
    await mkdir(join(folder, "tool-results"), { recursive: true })
    await writeFile(join(folder, "tool-results", "call-1.txt"), "a long output")
    await mkdir(join(home, ".claude", "file-history", nativeId), { recursive: true })
    await writeFile(join(home, ".claude", "file-history", nativeId, "abc@v1"), "before")
    await mkdir(join(home, ".claude", "todos"), { recursive: true })
    await writeFile(join(home, ".claude", "todos", `${nativeId}-agent-${nativeId}.json`), "[]")
  }, async ({ destination, forkId, report }) => {
    const found: string[] = []
    const project = (report.fork?.actions.find((action) => action.path.endsWith(`${forkId}.jsonl`))?.path ?? "").replace(/^claude:/, "").split("/").slice(0, -1).join("/")
    const at = (place: string) => join(destination, ".claude", place)
    const subagent = await readFile(at(`${project}/${forkId}/subagents/agent-a1.jsonl`), "utf8").catch(() => "")
    if (!subagent.includes(`"sessionId":"${forkId}"`)) found.push(`the subagent's transcript doesn't name the fork: ${subagent.slice(0, 120)}`)
    if (await readFile(at(`${project}/${forkId}/tool-results/call-1.txt`), "utf8").catch(() => "") !== "a long output") found.push("the tool result didn't move to the fork")
    if (await readFile(at(`file-history/${forkId}/abc@v1`), "utf8").catch(() => "") !== "before") found.push("the file snapshot didn't move to the fork")
    if (await readFile(at(`todos/${forkId}-agent-${forkId}.json`), "utf8").catch(() => "") !== "[]") found.push("the todo list didn't move to the fork")
    const transcript = (await readFile(at(`${project}/${forkId}.jsonl`), "utf8")).split("\n").filter(Boolean).map((line) => ClaudeLine.parse(JSON.parse(line)))
    if (transcript.some((line) => line.sessionId !== undefined && line.sessionId !== forkId)) found.push("a line of the fork names another session")
    if (!transcript.some((line) => line.uuid) || transcript.some((line) => line.uuid && line.forkedFrom?.messageUuid !== line.uuid)) found.push("a message of the fork doesn't say what it was copied from")
    return found
  })
}

/** OpenCode 1's rows: a message's parent and a part's message follow the ids the fork gives them, and a fork of a fork is numbered as OpenCode numbers it. */
function openCodeGenerationOne(): string[] {
  const found: string[] = []
  const ids = { from: "ses_aaa", to: "ses_bbb", derive: (name: string) => createHash("sha256").update(name).digest() }
  const rule = (table: string) => storeReader("opencode", tmpdir()).fork!.table("opencode:opencode.db", table, ids)
  const apply = (table: string, row: Record<string, string>) => {
    const forked = rule(table)
    if (forked === null || forked === "shared") throw new Error(`OpenCode's fork rule has no rows for ${table}`)
    const out = forked(row)
    if (out === "shared") throw new Error(`OpenCode's fork rule calls the session's ${table} row shared`)
    return out
  }
  const user = apply("message", { id: "msg_082cb5082001msY65A9If3887P", session_id: "ses_aaa", data: "{}" })
  const assistant = apply("message", { id: "msg_082cb508d001nptSPwVk5NPWQg", session_id: "ses_aaa", data: `{"parentID":"msg_082cb5082001msY65A9If3887P","role":"assistant"}` })
  const part = apply("part", { id: "prt_082cb8ab9001Szys3Xbg7ugE06", message_id: "msg_082cb508d001nptSPwVk5NPWQg", session_id: "ses_aaa", data: "{}" })
  if (!String(assistant["data"]).includes(`"parentID":"${String(user["id"])}"`)) found.push(`OpenCode 1: the assistant's parent isn't the fork's user message: ${String(assistant["data"])}`)
  if (part["message_id"] !== assistant["id"] || part["session_id"] !== "ses_bbb") found.push("OpenCode 1: the part doesn't follow its message")
  if (!String(user["id"]).startsWith("msg_082cb5082001") || user["id"] === "msg_082cb5082001msY65A9If3887P") found.push(`OpenCode 1: the message id ${String(user["id"])} doesn't keep its time or isn't new`)
  const session = apply("session", { id: "ses_aaa", title: "Notes (fork #2)", project_id: "p" })
  if (session["title"] !== "Notes (fork #3)" || "fork_session_id" in session) found.push(`OpenCode 1: the session row is ${JSON.stringify(session)}`)
  if (rule("project") !== "shared" || rule("instruction_blob") !== "shared") found.push("OpenCode: the project or instruction blobs aren't shared")
  return found
}

failures.push(...await linesCase())
failures.push(...await codexSideRecords())
failures.push(...await claudeSideRecords())
failures.push(...openCodeGenerationOne())
let pairs = 0
for (const harness of await readdir(FIXTURE_ROOT)) {
  const root = join(FIXTURE_ROOT, harness, PAIRS_FOLDER)
  const names = (await readdir(root).catch(() => [])).filter((name) => !name.includes("@")).sort()
  for (const name of names.slice(0, PAIRS_PER_HARNESS)) {
    const where = `${harness}/${PAIRS_FOLDER}/${name}`
    const pair = PairSchema.parse(JSON.parse(await readFile(join(root, name, "pair.json"), "utf8")))
    // A reader whose harness has no fork of its own (Devin's desktop app beside its CLI) isn't one this restores.
    for (const store of pair.stores.filter((candidate) => storeReader(candidate.reader, tmpdir()).fork)) {
      pairs++
      try {
        failures.push(...await forkPair(where, store.reader, pair.harness, join(root, name, "home"), store.path))
      } catch (error) {
        failures.push(`${where} ${store.reader}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      }
    }
  }
}

if (failures.length) {
  console.error(`\n${failures.join("\n")}\n`)
  process.exit(1)
}
console.log(`PASS: ${pairs} recorded sessions on every harness fork when their destination went on without Mako: the destination's copy left as it was, the arriving version a session of the harness's own that draws as it did, found again by a second restore, and left once it went on too`)

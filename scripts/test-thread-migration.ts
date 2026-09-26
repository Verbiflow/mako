import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  ClaudeProvider,
  CodexProvider,
  CursorProvider,
  GrokProvider,
  OpenCodeProvider,
  emitClaudeSession,
  emitCodexSession,
  emitCursorSession,
  emitGrokSession,
  threadIdentity,
  type SessionProvider,
  type Thread,
  type ThreadRef,
} from "@mako/sessions"
import { DevinCliProvider } from "../packages/sessions/dist/providers/devin-cli.js"
import type { ConversationControl } from "../electron/contracts/conversation-control.js"
import type { ThreadPlacement } from "../electron/contracts/thread-identity.js"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import type { LiveSnapshot } from "../electron/shared.js"
import { type JournalFacts, ThreadStore, threadStorePath } from "../electron/thread-store.js"

/**
 * Migration of existing journals and native sessions into the Thread store,
 * across a restart, for all six harnesses. Native stores are written into a
 * scratch home and read back by each provider's own reader; journals are
 * written with `LiveJournal`, as a host without the store left them.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-migration-")))
const home = join(root, "home")
const dataRoot = join(root, "data")
const conversations = join(dataRoot, "conversations")
const storePath = threadStorePath({ dataRoot, appData: join(root, "application-support") })
const CWD = "/tmp/thread-migration-project"
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function conversation(title: string): Thread {
  return {
    ref: { harness: "codex", nativeId: `source-${title}`, path: `/tmp/source-${title}.jsonl`, cwd: CWD, title },
    entries: [
      { kind: "user", at: "2026-09-26T10:00:00.000Z", text: `Plan the ${title} change` },
      { kind: "assistant", at: "2026-09-26T10:00:05.000Z", blocks: [{ type: "text", text: `The ${title} plan.` }] },
    ],
  }
}

async function rows(provider: SessionProvider): Promise<ThreadRef[]> {
  const refs = await Promise.all((await provider.discover()).map((file) => provider.peek(file)))
  return refs.filter((ref): ref is ThreadRef => ref !== null)
}

function devinStore(): void {
  const directory = join(home, ".local", "share", "devin", "cli")
  mkdirSync(directory, { recursive: true })
  const database = new DatabaseSync(join(directory, "sessions.db"))
  try {
    database.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, hidden INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
        working_directory TEXT NOT NULL, model TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, main_chain_id INTEGER);
      CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
        parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL);`)
    const session = database.prepare("INSERT INTO sessions VALUES (?, 0, ?, ?, 'swe-1-5', ?, ?, ?)")
    const message = database.prepare("INSERT INTO message_nodes VALUES (?, ?, 1, NULL, ?, ?)")
    for (const [index, id] of ["devin-a", "devin-b"].entries()) {
      session.run(id, 20 + index, CWD, `Devin ${id}`, 10 + index, 1)
      message.run(index + 1, id, JSON.stringify({ role: "user", content: `Hello from ${id}` }), 10 + index)
    }
  } finally {
    database.close()
  }
}

function openCodeStore(): void {
  const directory = join(home, ".local", "share", "opencode")
  mkdirSync(directory, { recursive: true })
  const database = new DatabaseSync(join(directory, "opencode.db"))
  try {
    database.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`)
    database.prepare("INSERT INTO project VALUES ('project', ?, 'Project', 1000, 1000)").run(CWD)
    const session = database.prepare("INSERT INTO session VALUES (?, 'project', NULL, ?, ?, ?, ?, NULL)")
    const message = database.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    const part = database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
    for (const [index, id] of ["ses_a", "ses_b"].entries()) {
      const at = 1000 + index * 100
      session.run(id, CWD, `OpenCode ${id}`, at, at + 50)
      message.run(`msg_${id}`, id, at, at, JSON.stringify({ role: "user", time: { created: at } }))
      part.run(`prt_${id}`, `msg_${id}`, id, at, at, JSON.stringify({ type: "text", text: `Hello from ${id}` }))
    }
  } finally {
    database.close()
  }
}

interface Native {
  claudeA: ThreadRef
  claudeAlias: ThreadRef
  claudeB: ThreadRef
  codexA: ThreadRef
  codexB: ThreadRef
  grokA: ThreadRef
  grokB: ThreadRef
  cursorAcp: ThreadRef
  cursorChats: ThreadRef
  cursorB: ThreadRef
  devinA: ThreadRef
  devinB: ThreadRef
  openCodeA: ThreadRef
  openCodeB: ThreadRef
}

const claudeAccount = join(root, "claude-account")

async function writeNativeStores(): Promise<void> {
  const claudeA = await emitClaudeSession(conversation("claude-a"), { cwd: CWD, home })
  await emitClaudeSession(conversation("claude-b"), { cwd: CWD, home })
  const alias = join(claudeAccount, "projects", relative(join(home, ".claude", "projects"), claudeA.path))
  mkdirSync(dirname(alias), { recursive: true })
  copyFileSync(claudeA.path, alias)
  await emitCodexSession(conversation("codex-a"), { cwd: CWD, home })
  await emitCodexSession(conversation("codex-b"), { cwd: CWD, home })
  await emitGrokSession(conversation("grok-a"), { cwd: CWD, home })
  await emitGrokSession(conversation("grok-b"), { cwd: CWD, home })
  // A `cursor-agent --resume` continuation of an ACP session: the same agent
  // ID in a second store under chats/.
  const chats = await emitCursorSession(conversation("cursor-a"), { cwd: CWD, home })
  const agent = (await rows(new CursorProvider(home, {}))).find((ref) => ref.path === chats.path)
  assert.ok(agent, "the Cursor reader lists the emitted store")
  const acp = join(home, ".cursor", "acp-sessions", agent.nativeId, "store.db")
  mkdirSync(dirname(acp), { recursive: true })
  copyFileSync(chats.path, acp)
  await emitCursorSession(conversation("cursor-b"), { cwd: CWD, home })
  devinStore()
  openCodeStore()
}

/** Every harness's own reader, as a host reads the catalog. */
async function readNative(): Promise<{ all: ThreadRef[]; named: Native }> {
  const claude = await rows(new ClaudeProvider(home, claudeAccount))
  const codex = await rows(new CodexProvider(home))
  const grok = await rows(new GrokProvider(home))
  const cursor = await rows(new CursorProvider(home, {}))
  const devin = await rows(new DevinCliProvider(home))
  const openCode = await rows(new OpenCodeProvider(home))
  const titled = (list: ThreadRef[], title: string) => {
    const found = list.filter((ref) => ref.title?.includes(title))
    assert.ok(found.length, `the ${title} session is listed`)
    return found
  }
  const inAccount = (ref: ThreadRef) => Number(ref.path.startsWith(claudeAccount))
  const [claudeA, claudeAlias] = titled(claude, "claude-a").sort((left, right) => inAccount(left) - inAccount(right))
  const cursorA = titled(cursor, "cursor-a")
  const named: Native = {
    claudeA: claudeA!,
    claudeAlias: claudeAlias!,
    claudeB: titled(claude, "claude-b")[0]!,
    codexA: titled(codex, "codex-a")[0]!,
    codexB: titled(codex, "codex-b")[0]!,
    grokA: titled(grok, "grok-a")[0]!,
    grokB: titled(grok, "grok-b")[0]!,
    cursorAcp: cursorA.find((ref) => ref.path.includes("acp-sessions"))!,
    cursorChats: cursorA.find((ref) => ref.path.includes(`${join(".cursor", "chats")}`))!,
    cursorB: titled(cursor, "cursor-b")[0]!,
    devinA: devin.find((ref) => ref.nativeId === "devin-a")!,
    devinB: devin.find((ref) => ref.nativeId === "devin-b")!,
    openCodeA: openCode.find((ref) => ref.nativeId === "ses_a")!,
    openCodeB: openCode.find((ref) => ref.nativeId === "ses_b")!,
  }
  for (const [name, ref] of Object.entries(named)) assert.ok(ref, `${name} is read by its provider`)
  assert.ok(claudeAlias?.path.startsWith(claudeAccount), "Claude lists the session under a second account path")
  assert.equal(named.claudeAlias.nativeId, named.claudeA.nativeId)
  assert.equal(threadIdentity(named.claudeAlias), threadIdentity(named.claudeA), "the Claude alias has the same catalog identity")
  assert.equal(named.cursorChats.nativeId, named.cursorAcp.nativeId, "the Cursor pair shares a native ID")
  assert.notEqual(threadIdentity(named.cursorChats), threadIdentity(named.cursorAcp), "the Cursor pair has distinct catalog identities")
  return { all: [...claude, ...codex, ...grok, ...cursor, ...devin, ...openCode], named }
}

let clock = Date.parse("2026-09-20T09:00:00.000Z")

function writeJournal(input: {
  harness: string
  threadPath?: string
  bindings: Array<{ provider: string; nativeId?: string; path?: string }>
  ancestry?: ConversationControl["ancestry"]
}): string {
  const id = randomUUID()
  clock += 60_000
  const bindings = input.bindings.map((binding, index) => ({
    id: index === 0 ? id : randomUUID(),
    provider: binding.provider,
    nativeId: binding.nativeId,
    path: binding.path,
    coveredBlocks: 0,
    includesBase: true,
  }))
  const snapshot: LiveSnapshot = {
    session: {
      id,
      harness: input.harness,
      nativeId: input.bindings[0]?.nativeId,
      cwd: CWD,
      status: "ready",
      connection: "disconnected",
      modes: [],
      currentMode: null,
      configOptions: [],
    },
    revision: 1,
    createdAt: clock,
    threadPath: input.threadPath,
    base: null,
    blocks: [],
    permissions: [],
    requests: [],
    control: {
      children: [],
      merges: [],
      ancestry: input.ancestry,
      activeBindingId: bindings.at(-1)?.id ?? id,
      bindings,
      transfers: [],
    },
  }
  const journal = new LiveJournal(conversations, id)
  try {
    journal.commit(snapshot)
  } finally {
    journal.close()
  }
  return id
}

function binding(ref: ThreadRef, withPath = true): JournalFacts["bindings"][number] {
  const named: JournalFacts["bindings"][number] = { provider: ref.harness, nativeId: ref.nativeId }
  if (withPath) named.path = ref.path
  return named
}

function host(threads: ThreadStore): LiveConversations {
  return new LiveConversations({
    root: conversations,
    appPath: root,
    threads,
    driver: () => undefined,
    history: async () => null,
    emit: () => {},
  })
}

function count(sql: string): number {
  const database = new DatabaseSync(storePath, { readOnly: true })
  try {
    return Number(Object.values(database.prepare(sql).get() ?? {})[0])
  } finally {
    database.close()
  }
}

async function migrationAcrossRestart(): Promise<void> {
  await writeNativeStores()
  const { all, named } = await readNative()
  const j = {
    claudeStarted: writeJournal({ harness: "claude", bindings: [binding(named.claudeA)] }),
    claudeReopened: writeJournal({ harness: "claude", threadPath: named.claudeA.path, bindings: [binding(named.claudeA)] }),
    claudeAliasReopened: writeJournal({ harness: "claude", threadPath: named.claudeAlias.path, bindings: [binding(named.claudeAlias)] }),
    codexStarted: writeJournal({ harness: "codex", bindings: [binding(named.codexA)] }),
    handoff: writeJournal({ harness: "codex", bindings: [binding(named.codexB), binding(named.grokB)] }),
    cursorAcp: writeJournal({ harness: "cursor", threadPath: named.cursorAcp.path, bindings: [binding(named.cursorAcp)] }),
    cursorChats: writeJournal({ harness: "cursor", threadPath: named.cursorChats.path, bindings: [binding(named.cursorChats)] }),
    openCodeStarted: writeJournal({ harness: "opencode", bindings: [binding(named.openCodeA, false)] }),
    openCodeReopened: writeJournal({ harness: "opencode", threadPath: named.openCodeA.path, bindings: [binding(named.openCodeA)] }),
  }
  const forked = writeJournal({
    harness: "claude",
    threadPath: named.claudeA.path,
    bindings: [],
    ancestry: { kind: "fork", parentId: j.claudeStarted, sourceRevision: 1, point: randomUUID() },
  })
  const child = writeJournal({
    harness: "devin",
    bindings: [binding(named.devinA)],
    ancestry: { kind: "delegation", parentId: j.codexStarted, sourceRevision: 1, point: randomUUID() },
  })
  const journalIds = { ...j, forked, child }

  // First start of a host with the store: every journal and catalog row is migrated.
  let threads = new ThreadStore(storePath)
  let owner = host(threads)
  const catalog = { kind: "service", name: "catalog" } as const
  let refs = threads.resolveRefs(all, catalog)
  const journalsAt = (store: ThreadStore) =>
    Object.fromEntries(Object.entries(journalIds).map(([name, id]) => [name, store.journalPlacement(id)]))
  const first = journalsAt(threads)
  const place = (ref: ThreadRef) => refs.get(ref.path)
  for (const [name, placed] of Object.entries(first)) assert.ok(placed, `${name} is registered at start`)
  const session = (name: keyof typeof journalIds) => first[name]?.session

  assert.equal(session("claudeReopened"), session("claudeStarted"), "claude: a reopened journal is the same Session")
  assert.equal(session("claudeAliasReopened"), session("claudeStarted"), "claude: a reopen through an account alias is the same Session")
  assert.equal(place(named.claudeA)?.session, session("claudeStarted"))
  assert.equal(place(named.claudeAlias)?.session, session("claudeStarted"), "claude: both account paths are one Session")
  assert.notEqual(session("forked"), session("claudeStarted"), "claude: a fork is its own Session")
  assert.notEqual(first.forked?.thread, first.claudeStarted?.thread, "claude: an existing fork keeps its own Thread")
  assert.equal(place(named.codexA)?.session, session("codexStarted"), "codex: the started journal owns its native session")
  assert.equal(place(named.codexB)?.session, session("handoff"), "codex: a handoff's first binding is its Session")
  assert.equal(place(named.grokB)?.session, session("handoff"), "grok: a handoff's second binding is the same Session")
  assert.notEqual(place(named.grokA)?.session, session("handoff"), "grok: an unrelated session is its own")
  assert.equal(place(named.cursorAcp)?.session, session("cursorAcp"), "cursor: the ACP row is the ACP journal's Session")
  assert.equal(place(named.cursorChats)?.session, session("cursorChats"), "cursor: the chats/ copy is its journal's Session")
  assert.notEqual(session("cursorAcp"), session("cursorChats"), "cursor: two stores with one native ID are two Sessions")
  assert.equal(place(named.devinA)?.session, session("child"), "devin: a delegated child's native row is the child's Session")
  assert.notEqual(session("child"), session("codexStarted"), "devin: a child is not its parent")
  assert.equal(session("openCodeReopened"), session("openCodeStarted"), "opencode: a pathless journal and its reopen are one Session")
  assert.equal(place(named.openCodeA)?.session, session("openCodeStarted"))

  // One Session per native session and per journal chain, one Thread per Session.
  const byIdentity = new Map<string, Set<string>>()
  for (const ref of all) {
    const placed = place(ref)
    assert.ok(placed, `${ref.harness} row ${ref.path} is placed`)
    const sessions = byIdentity.get(threadIdentity(ref)) ?? new Set<string>()
    sessions.add(placed.session)
    byIdentity.set(threadIdentity(ref), sessions)
  }
  for (const [identity, sessions] of byIdentity) assert.equal(sessions.size, 1, `${identity} maps to exactly one Session`)
  const distinct = new Set([...Object.values(first).map((placed) => placed!.session), ...[...refs.values()].map((placed) => placed.session)])
  assert.equal(distinct.size, 13, "thirteen conversations: nine native sessions with journals or rows, a fork, a child, and the Cursor pair split in two")
  assert.equal(count("SELECT count(*) FROM sessions WHERE merged_into IS NULL"), distinct.size)
  assert.equal(count("SELECT count(*) FROM threads WHERE merged_into IS NULL"), distinct.size, "every Session is alone in its own Thread")
  for (const placed of [...Object.values(first), ...refs.values()]) {
    const thread = threads.thread(placed!.thread)
    assert.equal(thread?.owner, threads.localPrincipal, "every Thread is owned by the local person")
    assert.deepEqual(thread?.sessions, [placed!.session])
  }
  const native = new Set(all.flatMap((ref) => [ref.nativeId, ref.path]))
  for (const id of distinct) {
    assert.match(id, UUID_V4, "Session IDs are random")
    assert.ok(!native.has(id) && !Object.values(journalIds).includes(id), "a Session ID is neither a native nor a conversation ID")
  }
  assert.equal(count("SELECT count(*) FROM threads WHERE created_by NOT LIKE '%\"service\"%'"), 0, "migrated Threads were created by Mako, not attributed to a person")
  // Eleven journals; the same-path reopen joined at registration, the alias
  // reopen and the OpenCode reopen joined when the catalog named their rows.
  assert.equal(count(`SELECT count(*) FROM sessions WHERE created_by LIKE '%"migration"%'`), 10, "journals were registered by the migration")
  const merges = count("SELECT count(*) FROM operations WHERE kind = 'merge'")
  assert.equal(merges, 2, "the alias reopen and the OpenCode reopen were joined by recorded merges")
  const firstRows = new Map(refs)
  const rowsBefore = count("SELECT count(*) FROM sessions")

  // An older host without the store writes another journal while this one is down.
  await owner.stop()
  threads.close()
  const late = writeJournal({ harness: "codex", threadPath: named.codexA.path, bindings: [binding(named.codexA)] })

  threads = new ThreadStore(storePath)
  owner = host(threads)
  refs = threads.resolveRefs((await readNative()).all, catalog)
  const second = journalsAt(threads)
  assert.deepEqual(second, first, "every journal keeps its Thread and Session across a restart")
  for (const [path, placed] of firstRows) assert.deepEqual(refs.get(path), placed, `${path} keeps its placement across a restart`)
  assert.equal(threads.journalPlacement(late)?.session, first.codexStarted?.session, "a journal an older host wrote joins its Session on restart")
  assert.equal(count("SELECT count(*) FROM sessions"), rowsBefore, "a restart mints nothing")
  assert.equal(count("SELECT count(*) FROM operations WHERE kind = 'merge'"), merges, "a restart merges nothing")
  assert.equal(count("SELECT count(*) FROM journals"), Object.keys(journalIds).length + 1)
  await owner.stop()
  threads.close()

  // IDs come from the store, not from the records: the same journals and rows
  // migrated into another store get other IDs.
  const elsewhere = new ThreadStore(join(root, "elsewhere.sqlite"))
  const elsewhereHost = host(elsewhere)
  assert.notEqual(elsewhere.journalPlacement(j.claudeStarted)?.session, first.claudeStarted?.session, "IDs are not derived from the journal or native session")
  await elsewhereHost.stop()
  elsewhere.close()
  console.log(JSON.stringify({ harnesses: 6, nativeRows: all.length, journals: Object.keys(journalIds).length + 1, sessions: distinct.size, merges }))
}

function fixtureDriver(): ProviderLiveDriver {
  return {
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    canResume: true,
    provider: "codex",
    available: () => true,
    start: async (cwd, options) => ({
      id: options.conversationId,
      nativeId: `native-${options.conversationId}`,
      harness: "codex",
      cwd,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    }),
    prompt: async () => {},
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
}

async function actors(): Promise<void> {
  const threads = new ThreadStore(join(root, "actors.sqlite"))
  const owner = new LiveConversations({
    root: join(root, "actors"),
    appPath: root,
    threads,
    driver: () => fixtureDriver(),
    history: async () => null,
    emit: () => {},
  })
  try {
    const desk = randomUUID()
    const deskRequest = randomUUID()
    await owner.start("codex", CWD, { conversationId: desk, initialRequest: { id: deskRequest, text: "hello", attachments: [] } })
    const relay = randomUUID()
    await owner.start("codex", CWD, { conversationId: relay, initialRequest: { id: randomUUID(), text: "from the relay", attachments: [] } }, { kind: "service", name: "relay" })
    for (let attempt = 0; attempt < 200 && owner.snapshot(desk)?.session.nativeId !== `native-${desk}`; attempt += 1)
      await new Promise<void>((resolve) => setImmediate(resolve))
    const person = { kind: "person", principal: threads.localPrincipal }
    assert.deepEqual(owner.snapshot(desk)?.requests.find((request) => request.id === deskRequest)?.actor, person, "a desk send is the local person's")
    assert.deepEqual(owner.snapshot(relay)?.requests[0]?.actor, { kind: "service", name: "relay" }, "a relayed job is the relay's")
    const followUp = randomUUID()
    owner.submit(desk, followUp, "and then", [])
    assert.deepEqual(owner.snapshot(desk)?.requests.find((request) => request.id === followUp)?.actor, person)
    const placed = threads.journalPlacement(desk)
    assert.ok(placed, "a started conversation is registered when its journal is created")
    assert.notEqual(placed.session, threads.journalPlacement(relay)?.session)
    const journal = new LiveJournal(join(root, "actors"), desk)
    try {
      assert.deepEqual(journal.read()?.requests.find((request) => request.id === deskRequest)?.actor, person, "the actor is journaled with the request")
    } finally {
      journal.close()
    }
    const path = join(root, "rollout-live.jsonl")
    const row: ThreadPlacement | undefined = threads.resolveRefs([{ harness: "codex", nativeId: `native-${desk}`, path }], { kind: "service", name: "catalog" }).get(path)
    assert.equal(row?.session, placed.session, "the native row a started conversation creates is that conversation's Session")
  } finally {
    await owner.stop()
    threads.close()
  }
}

try {
  await migrationAcrossRestart()
  await actors()
  console.log("thread migration: six harnesses migrated, stable across restart, actors recorded")
} finally {
  rmSync(root, { recursive: true, force: true })
}

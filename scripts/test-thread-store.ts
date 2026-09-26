import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Actor } from "../electron/contracts/thread-identity.js"
import {
  THREAD_STORE_SCHEMA,
  ThreadOperationConflictError,
  ThreadStore,
  ThreadStoreVersionError,
  threadStorePath,
  type JournalFacts,
  type SourceRef,
} from "../electron/thread-store.js"

const root = mkdtempSync(join(tmpdir(), "mako-thread-store-"))
const migration: Actor = { kind: "service", name: "migration" }
const catalog: Actor = { kind: "service", name: "catalog" }
let clock = 1_000
const now = () => clock++

function store(name: string): ThreadStore {
  return new ThreadStore(join(root, `${name}.sqlite`), { now })
}

function journal(input: Partial<JournalFacts> & Pick<JournalFacts, "harness">): JournalFacts {
  return { conversationId: randomUUID(), createdAt: clock++, bindings: [], ...input }
}

function row(harness: string, nativeId: string, path: string, identity?: string): SourceRef {
  const ref: SourceRef = { harness, nativeId, path }
  if (identity) ref.identity = identity
  return ref
}

function count(path: string, sql: string): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Number(Object.values(db.prepare(sql).get() ?? {})[0])
  } finally {
    db.close()
  }
}

function identityAndVersion(): void {
  const path = join(root, "identity.sqlite")
  const first = new ThreadStore(path, { now })
  const device = first.deviceId
  const principal = first.localPrincipal
  first.close()
  const reopened = new ThreadStore(path, { now })
  assert.equal(reopened.deviceId, device, "the device ID is minted once per store")
  assert.equal(reopened.localPrincipal, principal, "the local person is minted once per store")
  reopened.close()

  const db = new DatabaseSync(path)
  db.prepare("UPDATE store_meta SET value = ? WHERE key = 'schema'").run(String(THREAD_STORE_SCHEMA + 1))
  db.close()
  const before = readFileSync(path)
  assert.throws(() => new ThreadStore(path, { now }), ThreadStoreVersionError, "a newer schema is refused")
  assert.deepEqual(readFileSync(path), before, "a refused store is not written")

  assert.equal(threadStorePath({ dataRoot: "/tmp/fixture", appData: "/Users/me/Library/Application Support", home: "/Users/me" }), "/tmp/fixture/threads.sqlite", "a fixture root keeps its own store")
  assert.equal(threadStorePath({ dataRoot: "/Users/me/Library/Application Support/mako-dev", appData: "/Users/me/Library/Application Support", home: "/Users/me" }), "/Users/me/.mako/threads.sqlite", "every profile shares the per-user store")
}

function startedJournals(): void {
  const threads = store("started")
  const started = journal({ harness: "codex", bindings: [{ provider: "codex", nativeId: "codex-1", path: "/codex/rollout-1.jsonl" }] })
  const placed = threads.registerJournal(started, migration)
  assert.deepEqual(threads.registerJournal(started, migration), placed, "registering a journal again changes nothing")
  const thread = threads.thread(placed.thread)
  assert.equal(thread?.owner, threads.localPrincipal, "a migrated Thread is owned by the local person")
  assert.deepEqual(thread?.sessions, [placed.session], "a migrated Session is the only member of its Thread")
  assert.notEqual(placed.session, started.conversationId, "a Session ID is not a conversation ID")
  const other = threads.registerJournal(journal({ harness: "codex" }), migration)
  assert.notEqual(other.session, placed.session, "a journal with nothing in common gets its own Session")
  assert.notEqual(other.thread, placed.thread)
  threads.close()
}

function reopenedJournals(): void {
  const threads = store("reopen")
  const first = journal({ harness: "claude", bindings: [{ provider: "claude", nativeId: "claude-1", path: "/claude/a/claude-1.jsonl" }] })
  const second = journal({ harness: "claude", threadPath: "/claude/a/claude-1.jsonl", bindings: [{ provider: "claude", nativeId: "claude-1", path: "/claude/a/claude-1.jsonl" }] })
  const third = journal({ harness: "claude", threadPath: "/claude/a/claude-1.jsonl", bindings: [{ provider: "claude", nativeId: "claude-1" }] })
  const placed = threads.registerJournals([third, second, first], migration)
  assert.equal(placed.get(second.conversationId)?.session, placed.get(first.conversationId)?.session, "a reopened journal joins the Session it resumed")
  assert.equal(placed.get(third.conversationId)?.session, placed.get(first.conversationId)?.session)

  const pathless = journal({ harness: "devin", bindings: [{ provider: "devin", nativeId: "devin-1" }] })
  const again = journal({ harness: "devin", bindings: [{ provider: "devin", nativeId: "devin-1" }] })
  const devin = threads.registerJournals([pathless, again], migration)
  assert.equal(devin.get(again.conversationId)?.session, devin.get(pathless.conversationId)?.session, "pathless bindings of one native session share a Session")

  const unplaced = journal({ harness: "opencode", bindings: [{ provider: "opencode", nativeId: "oc-9" }] })
  const reopenedWithPath = journal({ harness: "opencode", threadPath: "/opencode/db#oc-9", bindings: [{ provider: "opencode", nativeId: "oc-9", path: "/opencode/db#oc-9" }] })
  threads.registerJournals([unplaced, reopenedWithPath], migration)
  threads.resolveRefs([row("opencode", "oc-9", "/opencode/db#oc-9")], catalog)
  assert.equal(threads.journalPlacement(reopenedWithPath.conversationId)?.session, threads.journalPlacement(unplaced.conversationId)?.session, "a pathless journal and a reopen with the path join once the catalog names the row")
  threads.close()
}

function distinctStores(): void {
  const threads = store("collision")
  const acp = journal({ harness: "cursor", threadPath: "/cursor/chats/w/agent-1/store.db", bindings: [{ provider: "cursor", nativeId: "agent-1", path: "/cursor/chats/w/agent-1/store.db" }] })
  const copy = journal({ harness: "cursor", threadPath: "/cursor/projects/p/agent-1.jsonl", bindings: [{ provider: "cursor", nativeId: "agent-1", path: "/cursor/projects/p/agent-1.jsonl" }] })
  const placed = threads.registerJournals([acp, copy], migration)
  assert.notEqual(placed.get(acp.conversationId)?.session, placed.get(copy.conversationId)?.session, "two stores with one native ID stay two Sessions")
  const rows = threads.resolveRefs([
    row("cursor", "agent-1", "/cursor/projects/p/agent-1.jsonl", "chats:agent-1"),
    row("cursor", "agent-1", "/cursor/chats/w/agent-1/store.db"),
  ], catalog)
  assert.equal(rows.get("/cursor/chats/w/agent-1/store.db")?.session, placed.get(acp.conversationId)?.session)
  assert.equal(rows.get("/cursor/projects/p/agent-1.jsonl")?.session, placed.get(copy.conversationId)?.session)
  assert.equal(threads.conflicts.length, 0)

  const fresh = store("collision-catalog")
  const catalogOnly = fresh.resolveRefs([
    row("cursor", "agent-2", "/cursor/chats/w/agent-2/store.db"),
    row("cursor", "agent-2", "/cursor/projects/p/agent-2.jsonl", "chats:agent-2"),
  ], catalog)
  assert.notEqual(catalogOnly.get("/cursor/chats/w/agent-2/store.db")?.session, catalogOnly.get("/cursor/projects/p/agent-2.jsonl")?.session, "catalog rows with different identities are different Sessions")
  fresh.close()
  threads.close()
}

function claudeAliases(): void {
  for (const order of ["account first", "alias first"] as const) {
    const threads = store(`aliases-${order.replace(" ", "-")}`)
    const owner = journal({ harness: "claude", bindings: [{ provider: "claude", nativeId: "claude-2", path: "/claude/account/claude-2.jsonl" }] })
    const placed = threads.registerJournal(owner, migration)
    const account = row("claude", "claude-2", "/claude/account/claude-2.jsonl")
    const alias = row("claude", "claude-2", "/claude/default/claude-2.jsonl")
    const refs = order === "account first" ? [account, alias] : [alias, account]
    for (const ref of refs) threads.place(ref, catalog)
    assert.equal(threads.place(alias, catalog).session, placed.session, `${order}: an account alias is the journal's Session`)
    assert.equal(threads.place(account, catalog).session, placed.session)
    assert.equal(threads.conflicts.length, 0)
    threads.close()
  }

  const threads = store("aliases-reopen")
  const first = journal({ harness: "claude", bindings: [{ provider: "claude", nativeId: "claude-3", path: "/claude/account/claude-3.jsonl" }] })
  const reopened = journal({ harness: "claude", threadPath: "/claude/default/claude-3.jsonl", bindings: [{ provider: "claude", nativeId: "claude-3", path: "/claude/default/claude-3.jsonl" }] })
  const placed = threads.registerJournals([first, reopened], migration)
  assert.notEqual(placed.get(first.conversationId)?.session, placed.get(reopened.conversationId)?.session, "before the catalog, different paths are not assumed to be one session")
  threads.resolveRefs([
    row("claude", "claude-3", "/claude/default/claude-3.jsonl"),
    row("claude", "claude-3", "/claude/account/claude-3.jsonl"),
  ], catalog)
  assert.equal(threads.journalPlacement(reopened.conversationId)?.session, threads.journalPlacement(first.conversationId)?.session, "the catalog identity joins a reopen through an alias")
  const merged = placed.get(reopened.conversationId)?.session
  assert.ok(merged)
  assert.deepEqual(threads.sessionPlacement(merged), threads.journalPlacement(first.conversationId), "a merged Session's ID still resolves")
  threads.close()
}

function symlinkedRoots(): void {
  const real = join(root, "native", "claude", "projects")
  const profile = join(root, "native", "router-profile")
  mkdirSync(join(real, "repo"), { recursive: true })
  mkdirSync(profile, { recursive: true })
  symlinkSync(real, join(profile, "projects"))
  writeFileSync(join(real, "repo", "claude-7.jsonl"), "{}\n")
  const devin = join(root, "native", "devin")
  mkdirSync(devin, { recursive: true })
  writeFileSync(join(devin, "sessions.db"), "")
  symlinkSync(devin, join(root, "native", "devin-link"))

  const threads = store("symlinks")
  const opened = journal({ harness: "claude", threadPath: join(profile, "projects", "repo", "claude-7.jsonl"), bindings: [{ provider: "claude", nativeId: "claude-7", path: join(profile, "projects", "repo", "claude-7.jsonl") }] })
  const placed = threads.registerJournal(opened, migration)
  const listed = realpathSync(join(real, "repo", "claude-7.jsonl"))
  assert.equal(threads.resolveRefs([row("claude", "claude-7", listed)], catalog).get(listed)?.session, placed.session, "a path through a symlinked root is the file the catalog lists")
  const child = journal({ harness: "devin", bindings: [{ provider: "devin", nativeId: "devin-7", path: `${join(root, "native", "devin-link", "sessions.db")}#devin-7` }] })
  const devinPlace = threads.registerJournal(child, migration)
  const devinRow = `${realpathSync(join(devin, "sessions.db"))}#devin-7`
  assert.equal(threads.resolveRefs([row("devin", "devin-7", devinRow)], catalog).get(devinRow)?.session, devinPlace.session, "a session inside a database keeps its suffix")
  assert.equal(threads.conflicts.length, 0)
  threads.close()
}

function ancestry(): void {
  const threads = store("ancestry")
  const parent = journal({ harness: "claude", threadPath: "/claude/a/parent.jsonl", bindings: [{ provider: "claude", nativeId: "parent", path: "/claude/a/parent.jsonl" }] })
  const fork = journal({ harness: "claude", threadPath: "/claude/a/parent.jsonl", ancestry: { kind: "fork", parentId: parent.conversationId } })
  const child = journal({ harness: "codex", ancestry: { kind: "delegation", parentId: parent.conversationId }, bindings: [{ provider: "codex", nativeId: "child", path: "/codex/child.jsonl" }] })
  const placed = threads.registerJournals([child, fork, parent], migration)
  const parentSession = placed.get(parent.conversationId)?.session
  assert.notEqual(placed.get(fork.conversationId)?.session, parentSession, "a fork is its own Session")
  assert.notEqual(placed.get(fork.conversationId)?.thread, placed.get(parent.conversationId)?.thread, "an existing fork keeps its own Thread")
  assert.notEqual(placed.get(child.conversationId)?.session, parentSession, "a delegated child is its own Session")
  assert.equal(threads.resolveRefs([row("claude", "parent", "/claude/a/parent.jsonl")], catalog).get("/claude/a/parent.jsonl")?.session, parentSession, "the parent's native row stays the parent's")

  const forkNative = { ...fork, bindings: [{ provider: "claude", nativeId: "parent", path: "/claude/a/parent.jsonl" }] }
  assert.equal(threads.registerJournal(forkNative, migration).session, placed.get(fork.conversationId)?.session, "a fork binding that names its parent's store is not merged")
  assert.equal(threads.journalPlacement(parent.conversationId)?.session, parentSession)
  assert.equal(threads.conflicts.length, 1, "the disagreement is reported")

  const childRow = threads.resolveRefs([row("codex", "child", "/codex/child.jsonl")], catalog)
  assert.equal(childRow.get("/codex/child.jsonl")?.session, placed.get(child.conversationId)?.session, "a child's native row is the child's Session")
  threads.close()
}

function handoffAndCatalogFirst(): void {
  const threads = store("handoff")
  const imported = threads.resolveRefs([row("codex", "codex-9", "/codex/rollout-9.jsonl")], catalog).get("/codex/rollout-9.jsonl")
  const captured = journal({ harness: "codex", threadPath: "/codex/rollout-9.jsonl", bindings: [{ provider: "codex", nativeId: "codex-9", path: "/codex/rollout-9.jsonl" }] })
  assert.deepEqual(threads.registerJournal(captured, catalog), imported, "capturing a row keeps its identity")

  const handoff = journal({ harness: "claude", bindings: [{ provider: "claude", nativeId: "claude-9", path: "/claude/a/claude-9.jsonl" }] })
  const placed = threads.registerJournal(handoff, migration)
  const early = threads.resolveRefs([row("grok", "grok-9", "/grok/grok-9")], catalog).get("/grok/grok-9")
  assert.ok(early)
  const extended = { ...handoff, bindings: [...handoff.bindings, { provider: "grok", nativeId: "grok-9", path: "/grok/grok-9" }] }
  assert.deepEqual(threads.registerJournal(extended, migration), placed, "a handoff stays in its Session")
  assert.deepEqual(threads.sessionPlacement(early.session), placed, "a Session the catalog minted first joins the handoff's")
  assert.equal(threads.thread(early.thread)?.id, placed.thread, "its Thread resolves to the handoff's Thread")
  threads.close()
}

function conflicts(): void {
  const threads = store("conflicts")
  const named = threads.resolveRefs([row("opencode", "oc-1", "/opencode/oc-1")], catalog).get("/opencode/oc-1")
  assert.ok(named)
  threads.renameThread({ operationId: randomUUID(), thread: named.thread, title: "Release notes", actor: threads.person() })
  const grouped = journal({ harness: "opencode", bindings: [{ provider: "opencode", nativeId: "oc-2", path: "/opencode/oc-2" }] })
  const groupedPlace = threads.registerJournal(grouped, migration)
  threads.createSession({ operationId: randomUUID(), thread: groupedPlace.thread, actor: threads.person() })
  const extended = { ...grouped, bindings: [...grouped.bindings, { provider: "opencode", nativeId: "oc-1", path: "/opencode/oc-1" }] }
  assert.deepEqual(threads.registerJournal(extended, migration), groupedPlace)
  assert.equal(threads.resolveRefs([row("opencode", "oc-1", "/opencode/oc-1")], catalog).get("/opencode/oc-1")?.session, named.session, "a titled Thread is never merged away")
  assert.equal(threads.conflicts.length, 1)
  threads.close()
}

function receipts(): void {
  const threads = store("receipts")
  const placed = threads.registerJournal(journal({ harness: "grok", bindings: [{ provider: "grok", nativeId: "g", path: "/grok/g" }] }), migration)
  const operationId = randomUUID()
  const created = threads.createSession({ operationId, thread: placed.thread, actor: threads.person() })
  assert.deepEqual(threads.createSession({ operationId, thread: placed.thread, actor: threads.person() }), created, "a repeated operation returns its first result")
  assert.deepEqual(threads.thread(placed.thread)?.sessions, [placed.session, created.session], "the new Session is the Thread's next tab")
  const other = threads.registerJournal(journal({ harness: "grok" }), migration)
  assert.throws(() => threads.createSession({ operationId, thread: other.thread, actor: threads.person() }), ThreadOperationConflictError, "a reused operation ID with other content is refused")
  const tab = journal({ harness: "cursor", session: created.session, bindings: [{ provider: "cursor", nativeId: "tab", path: "/cursor/tab" }] })
  assert.deepEqual(threads.registerJournal(tab, threads.person()), created, "a journal started in a + tab registers into it")
  const renamed = threads.renameThread({ operationId: randomUUID(), thread: placed.thread, title: "  Parser  ", actor: threads.person() })
  assert.equal(renamed.title, "Parser")
  assert.equal(renamed.titleSource, "user")
  threads.close()
}

function twoHosts(): void {
  const path = join(root, "shared.sqlite")
  const first = new ThreadStore(path, { now })
  const second = new ThreadStore(path, { now })
  const ref = row("codex", "shared", "/codex/shared.jsonl")
  const fromFirst = first.place(ref, catalog)
  assert.deepEqual(second.place(ref, catalog), fromFirst, "a second host reads the first host's answer")
  const alias = row("claude", "c", "/claude/default/c.jsonl")
  const early = second.place(alias, catalog)
  first.registerJournal(journal({ harness: "claude", bindings: [{ provider: "claude", nativeId: "c", path: "/claude/account/c.jsonl" }] }), migration)
  const joined = first.place(row("claude", "c", "/claude/account/c.jsonl"), catalog)
  assert.notEqual(joined.session, early.session, "the first host merged the catalog-only Session")
  assert.deepEqual(second.place(alias, catalog), joined, "another host's merge clears the second host's memory")
  assert.equal(count(path, "SELECT count(*) FROM sources"), 2)
  first.close()
  second.close()
}

try {
  identityAndVersion()
  startedJournals()
  reopenedJournals()
  distinctStores()
  claudeAliases()
  symlinkedRoots()
  ancestry()
  handoffAndCatalogFirst()
  conflicts()
  receipts()
  twoHosts()
  console.log("thread store: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}

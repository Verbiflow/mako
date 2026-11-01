import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadPage, ThreadRef } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import type { ReportedSession } from "@mako/protocol/thread-listing"
import { HostJobs } from "@mako/host/base/host-jobs"
import { backgroundAgentEntry, BACKGROUND_AGENT_START_MS, type BackgroundAgentRecord } from "@mako/host/contracts/background-agents"
import { backgroundWork, backgroundWorkText } from "@mako/host/contracts/background-work"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { withBackgroundAgents } from "@mako/host/contracts/native-agents"
import { listedAsThread, threadList } from "@mako/host/contracts/thread-list"
import { BackgroundAgents, lastStep, type BackgroundAgentsDeps } from "@mako/host/conversations/background-agents"
import { uploadScope } from "@mako/host/conversations/session-uploads"
import { ThreadStore } from "@mako/host/threads/store"

const root = mkdtempSync(join(tmpdir(), "mako-background-agents-"))
const NOW = 1_800_000_000_000

function record(overrides: Partial<BackgroundAgentRecord> = {}): BackgroundAgentRecord {
  return {
    id: randomUUID(),
    parent: randomUUID(),
    harness: "claude",
    nativeId: randomUUID(),
    title: "Review the sidebar",
    origin: "started",
    device: randomUUID(),
    process: { pid: 4242 },
    startedAt: NOW - 60_000,
    ...overrides,
  }
}

function entryStates(): void {
  const running = record()
  assert.deepEqual(backgroundAgentEntry(running, { alive: true }, NOW).state, { kind: "working", activity: "Starting" }, "a run with no Session yet is starting")
  const session = { path: "/claude/a.jsonl" }
  assert.deepEqual(backgroundAgentEntry(running, { alive: true, session, step: "Shell npm test" }, NOW).state, { kind: "working", activity: "Shell npm test" }, "a run says its last step")
  assert.equal(backgroundAgentEntry(running, { alive: true, session }, NOW).stoppable, true, "a live process on this device can be stopped")
  assert.deepEqual(backgroundAgentEntry(running, { alive: true, session, activity: "needs-input" }, NOW).state, { kind: "waiting", reason: "Waiting on you in its own terminal" })
  const ended = backgroundAgentEntry({ ...running, ended: { at: NOW, kind: "done", detail: "Fixed it.", toolUses: 9 } }, { alive: true, session, step: "Shell npm test" }, NOW)
  assert.deepEqual(ended.state, { kind: "completed", summary: "Fixed it." }, "an end is final, whatever is read after it")
  assert.equal(ended.stoppable, false)
  assert.equal(ended.usage?.toolUses, 9, "an ended run keeps the calls it was counted at")
  assert.equal(ended.settledAt, NOW)
  assert.deepEqual(backgroundAgentEntry({ ...running, ended: { at: NOW, kind: "stopped" } }, {}, NOW).state, { kind: "canceled" })
  assert.equal(backgroundAgentEntry({ ...running, ended: { at: NOW, kind: "failed", detail: "It exited with code 2." } }, {}, NOW).state.kind, "failed")
  const elsewhere = record({ process: undefined, startedAt: NOW - BACKGROUND_AGENT_START_MS - 1 })
  assert.equal(backgroundAgentEntry(elsewhere, {}, NOW).state.kind, "unknown", "a run this device can't see is never shown at work")
  assert.equal(backgroundAgentEntry(record({ process: undefined }), {}, NOW).state.kind, "working", "until its start window passes")
  const entry = backgroundAgentEntry(running, { alive: true, session }, NOW)
  assert.equal(entry.detached?.path, "/claude/a.jsonl", "its transcript opens from its Session's path")
  assert.equal(entry.provider, "claude", "its harness draws its icon")
}

function rosterAndFooter(): void {
  const provider = { nativeId: "sub", title: "Explore", work: "agent" as const, state: { kind: "working" as const }, bindingId: "binding", provider: "claude", observedAt: NOW, stoppable: true }
  const detached = backgroundAgentEntry(record(), { alive: true }, NOW)
  const roster = withBackgroundAgents({ agents: [provider], limited: false }, [detached])
  assert.equal(roster?.agents.length, 2)
  assert.equal(withBackgroundAgents(roster, [detached]), roster, "the same entries keep the same roster")
  const closed = backgroundWork({ status: "ready", connection: "hibernated" }, roster)
  assert.equal(closed?.count, 1, "a hibernated conversation still waits on its background agents, which are Mako's")
  assert.equal(backgroundWorkText(closed!), "an agent")
}

function listsSkipHelpers(): void {
  const helper: ThreadRef = { harness: "claude", nativeId: "h", path: "/h.jsonl", agentOf: { session: randomUUID(), agent: randomUUID() } }
  const own: ThreadRef = { harness: "claude", nativeId: "o", path: "/o.jsonl" }
  assert.equal(listedAsThread(helper), false)
  assert.deepEqual(threadList([helper, own]).map((ref) => ref.path), ["/o.jsonl"], "a background agent is never a Thread of its own")
}

function uploadsFollowParents(): void {
  const parent = randomUUID()
  const at = new Date(NOW - 60_000).toISOString()
  const rows: ReportedSession[] = [{ session: parent, thread: randomUUID(), conversation: "parent", harness: "codex", nativeId: "parent", title: "Parent", state: "idle", createdAt: at, activityAt: at, generation: 1 }]
  const scope = uploadScope(rows, { onBattery: false, percent: undefined, lowPower: false }, (harness, nativeId) => `/${harness}/${nativeId}`, NOW, (session) => (session === parent ? [{ harness: "cursor", nativeId: "helper" }] : []))
  assert.deepEqual(scope.sessions.map((session) => `${session.harness}:${session.nativeId}`), ["codex:parent", "cursor:helper"], "a helper's Session syncs right after its parent's, under its Thread")
  assert.equal(scope.sessions[1]!.thread, scope.sessions[0]!.thread)
}

function store(name: string): ThreadStore {
  return new ThreadStore(join(root, `${name}.sqlite`), { now: () => Date.now() })
}

function parentSession(threads: ThreadStore) {
  const conversation = randomUUID()
  const placed = threads.registerJournal({ conversationId: conversation, createdAt: Date.now(), harness: "codex", bindings: [] }, { kind: "service", name: "workspace" })
  return { conversation, session: placed.session }
}

function storeKeeps(): void {
  const threads = store("keeps")
  const { session } = parentSession(threads)
  assert.throws(() => threads.keepBackgroundAgent(record({ parent: randomUUID(), device: threads.deviceId })), /parent Session/, "a background agent needs its parent Session")
  const kept = threads.keepBackgroundAgent(record({ parent: session, device: threads.deviceId, nativeId: "native-1" }))
  assert.equal(threads.backgroundAgents().of(session).length, 1)
  assert.equal(threads.backgroundAgents().at("claude", "native-1")?.id, kept.id)
  const again = threads.keepBackgroundAgent(record({ parent: session, device: threads.deviceId, nativeId: "native-1" }))
  assert.equal(again.id, kept.id, "one harness Session is one background agent")
  const ended = threads.keepBackgroundAgent({ ...kept, ended: { at: 1, kind: "done" } })
  const later = threads.keepBackgroundAgent({ ...ended, ended: { at: 2, kind: "failed" }, title: "Renamed" })
  assert.deepEqual(later.ended, { at: 1, kind: "done" }, "an end is said once")
  assert.equal(later.title, "Renamed")
  assert.equal(threads.conversationsOf(session).length, 1)
  threads.close()
  const reopened = store("keeps")
  assert.equal(reopened.backgroundAgents().all.length, 1, "background agents are kept across hosts")
  reopened.close()
}

interface FakeSession {
  ref: ThreadRef
  entries: Entry[]
}

function fakeCatalog() {
  const sessions = new Map<string, FakeSession>()
  const subscribers = new Set<(event: HostEvent) => void>()
  const announced: string[] = []
  const catalog: BackgroundAgentsDeps["catalog"] = {
    nativePath: (identity) => [...sessions.values()].find((session) => session.ref.harness === identity.harness && session.ref.nativeId === identity.nativeId)?.ref.path,
    ref: (path) => sessions.get(path)?.ref,
    async page(path, before, limit = 50) {
      const session = sessions.get(path)
      if (!session) return null
      const end = before ?? session.entries.length
      const start = Math.max(0, end - limit)
      return { ref: session.ref, entries: session.entries.slice(start, end), start, total: session.entries.length, hasEarlier: start > 0 } satisfies ThreadPage
    },
    activity: () => ({}),
    subscribe(subscriber) {
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    },
    announce: (path) => { announced.push(path) },
  }
  return {
    catalog,
    announced,
    write(ref: ThreadRef, entries: Entry[]) {
      sessions.set(ref.path, { ref, entries })
      for (const subscriber of subscribers) subscriber({ type: "thread-ref", ref })
    },
  }
}

function tool(id: string, name: string, input: Record<string, string>): Entry {
  return { type: "tool", id, name, input: JSON.stringify(input), status: "completed" }
}

function text(id: string, value: string): Entry {
  return { type: "text", id, text: value }
}

function stepWording(): void {
  assert.equal(lastStep([tool("1", "Bash", { command: "npm test" })], "claude"), "Shell npm test", "a step reads as the transcript's tool row")
  assert.equal(lastStep([tool("1", "Bash", { command: "npm test" }), text("2", "## All green")], "claude"), "All green")
  assert.equal(lastStep([{ type: "user", id: "u", text: "Go" }], "claude"), undefined)
}

async function until(check: () => boolean, what: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function followsRuns(): Promise<void> {
  const threads = store("follows")
  const { conversation } = parentSession(threads)
  const fake = fakeCatalog()
  const jobs = new HostJobs()
  const changes: string[] = []
  let nativeId = randomUUID()
  const helperPath = `/claude/${nativeId}.jsonl`
  let script = "exit 0"
  const deps: BackgroundAgentsDeps = {
    store: () => threads,
    catalog: fake.catalog,
    jobs,
    root: join(root, "runs"),
    prepare: async () => ({ executable: "/bin/sh", args: ["-c", script], env: { ...process.env }, session: nativeId, dropped: [] }),
    runs: () => true,
    conversationOwns: () => false,
    changed: (id) => changes.push(id),
  }
  const agents = new BackgroundAgents(deps)
  try {
    script = "sleep 0.3; exit 0"
    const started = await agents.start(conversation, { harness: "claude", prompt: "Review the sidebar\nand more", cwd: root })
    assert.equal(started.nativeId, nativeId, "a run Mako starts names its Session up front")
    assert.equal(agents.roster(conversation)[0]?.state.kind, "working")
    assert.equal(agents.roster(conversation), agents.roster(conversation), "the roster keeps its identity while nothing changes")
    fake.write({ harness: "claude", nativeId, path: helperPath, startedAt: new Date().toISOString() }, [tool("1", "Bash", { command: "npm test" }), tool("2", "Read", { file_path: "/a.ts" }), text("3", "Done: the sidebar is clean.")])
    await until(() => agents.roster(conversation)[0]?.usage?.toolUses === 2, "its calls counted")
    await until(() => agents.roster(conversation)[0]?.state.kind === "completed", "its end")
    const done = agents.roster(conversation)[0]!
    assert.deepEqual(done.state, { kind: "completed", summary: "Done: the sidebar is clean." }, "an exit of 0 ends it done, with its last reply")
    assert.ok(changes.includes(conversation), "its conversation hears of each change")
    assert.equal(threads.backgroundAgents().at("claude", nativeId)?.ended?.kind, "done", "the end is written to the store")

    nativeId = randomUUID()
    script = "echo 'no browser here' >&2; exit 3"
    const failing = await agents.start(conversation, { harness: "claude", prompt: "Record the footer", cwd: root })
    await until(() => threads.backgroundAgents().all.find((agent) => agent.id === failing.id)?.ended !== undefined, "a failing run's end")
    const failed = threads.backgroundAgents().all.find((agent) => agent.id === failing.id)!.ended!
    assert.equal(failed.kind, "failed")
    assert.match(failed.detail ?? "", /code 3: no browser here/, "a failure says its exit code and last error line")

    nativeId = randomUUID()
    script = "sleep 30"
    const long = await agents.start(conversation, { harness: "claude", prompt: "Wait", cwd: root })
    assert.equal(await agents.stop(randomUUID(), long.id), false, "another conversation can't stop it")
    assert.equal(await agents.stop(conversation, long.id), true)
    const stopped = threads.backgroundAgents().all.find((agent) => agent.id === long.id)!
    assert.equal(stopped.ended?.kind, "stopped")
    await until(() => {
      try {
        process.kill(stopped.process!.pid, 0)
        return false
      } catch {
        return true
      }
    }, "its process group to end")

    const linkedId = randomUUID()
    fake.write({ harness: "cursor", nativeId: linkedId, path: `/cursor/${linkedId}/store.db`, startedAt: new Date().toISOString(), title: "Worker" }, [tool("1", "Shell", { command: "ls" }), text("2", "Finished the review.")])
    const linked = await agents.link(conversation, { harness: "cursor", session: linkedId })
    assert.equal(linked.origin, "linked")
    assert.equal(linked.ended?.kind, "done", "a run linked after it ended ends from what its Session last shows")
    assert.ok(fake.announced.includes(`/cursor/${linkedId}/store.db`), "a linked Session is announced again, so every list drops it")
    await assert.rejects(agents.link(randomUUID(), { harness: "cursor", session: linkedId }), /Thread store|another conversation/)
    assert.match(agents.describe(conversation), /done/)
  } finally {
    agents.dispose()
    jobs.stop()
    threads.close()
  }
}

async function restartHeals(): Promise<void> {
  const threads = store("heals")
  const { conversation, session } = parentSession(threads)
  const gone = threads.keepBackgroundAgent(record({ parent: session, device: threads.deviceId, process: { pid: 999_999, startedAt: NOW }, runDir: join(root, "gone") }))
  const fake = fakeCatalog()
  const jobs = new HostJobs()
  const agents = new BackgroundAgents({
    store: () => threads,
    catalog: fake.catalog,
    jobs,
    root,
    prepare: () => Promise.reject(new Error("This test starts no run")),
    runs: () => true,
    conversationOwns: () => false,
    changed: () => {},
  })
  try {
    await until(() => threads.backgroundAgents().all.find((agent) => agent.id === gone.id)?.ended !== undefined, "a run that ended while no host watched")
    assert.equal(agents.roster(conversation)[0]?.state.kind, "unknown", "it never shows running once its process is gone")
  } finally {
    agents.dispose()
    jobs.stop()
    threads.close()
  }
}

try {
  entryStates()
  rosterAndFooter()
  listsSkipHelpers()
  uploadsFollowParents()
  storeKeeps()
  stepWording()
  await followsRuns()
  await restartHeals()
  console.log("background agents: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}

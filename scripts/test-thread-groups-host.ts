import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { HostEvent } from "../electron/contracts/host-events-boot.js"
import type { ThreadPlacement } from "../electron/contracts/thread-identity.js"
import { LiveConversations } from "../electron/live-conversations.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import type { LiveSessionState } from "../electron/shared.js"
import { ThreadStore } from "../electron/thread-store.js"

/**
 * A Thread with several Sessions in the conversation host, for all six
 * harnesses: live summaries and snapshots name their Thread and Session, a
 * fork joins its parent's Thread unless asked for a new one, a `+` tab's
 * first message starts any harness in the Session the tab created, and a
 * restart places every journal where it was.
 */

const HARNESSES = ["claude", "codex", "cursor", "grok", "devin", "opencode"] as const
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-groups-host-")))
const storePath = join(root, "threads.sqlite")
const journals = join(root, "journals")
const CWD = "/tmp/thread-groups-project"

function driver(harness: string, owner: () => LiveConversations): ProviderLiveDriver {
  const sessions = new Map<string, LiveSessionState>()
  return {
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    provider: harness,
    canResume: true,
    available: () => true,
    start: async (cwd, options) => {
      const session: LiveSessionState = {
        id: options.conversationId,
        nativeId: options.resume ?? `native-${harness}-${options.conversationId}`,
        harness,
        cwd,
        status: "ready",
        connection: "connected",
        modes: [],
        currentMode: null,
        configOptions: [],
      }
      sessions.set(options.conversationId, session)
      return session
    },
    prompt: async (id) => {
      const session = sessions.get(id)
      assert.ok(session, "a prompt goes to a started session")
      owner().observe({ type: "live-session", session: { ...session, status: "running" } })
      owner().observe({ type: "live-session", session })
    },
    permission: async () => {},
    cancel: async () => {},
    setMode: async () => {},
    close: async () => {},
  }
}

function host(threads: ThreadStore, events: HostEvent[]): LiveConversations {
  let owner: LiveConversations | undefined
  const self = () => {
    assert.ok(owner)
    return owner
  }
  const drivers = new Map<string, ProviderLiveDriver>(HARNESSES.map((harness) => [harness, driver(harness, self)]))
  owner = new LiveConversations({
    root: journals,
    appPath: root,
    threads,
    driver: (provider) => drivers.get(provider),
    history: async () => null,
    emit: (event) => { events.push(event) },
    nativePath: (session) => session.nativeId ? join(root, "native", session.harness, `${session.nativeId}.jsonl`) : undefined,
    checkpoint: async () => "checkpoint",
    providerIdleMs: 60_000,
    providerWarmLimit: 20,
  })
  return owner
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await delay(2)
  assert.ok(check(), what)
}

function placementOf(owner: LiveConversations, id: string): { thread: string; session: string } | undefined {
  const summary = owner.summaries().find((candidate) => candidate.session.id === id)
  return summary?.threadId && summary.sessionId ? { thread: summary.threadId, session: summary.sessionId } : undefined
}

function lastGroup(events: HostEvent[], thread: string): string[] | undefined {
  const found = events.findLast((event) => event.type === "thread-group" && event.change.thread === thread)
  return found?.type === "thread-group" ? found.change.group?.sessions.map((session) => session.id) : undefined
}

async function main(): Promise<void> {
  const threads = new ThreadStore(storePath, { realPath: (path) => path })
  const events: HostEvent[] = []
  let owner = host(threads, events)
  const expected = new Map<string, ThreadPlacement>()

  for (const [index, harness] of HARNESSES.entries()) {
    const id = randomUUID()
    const seed = randomUUID()
    await owner.start(harness, CWD, { conversationId: id, initialRequest: { id: seed, text: "seed", attachments: [] } })
    await until(() => owner.snapshot(id)?.requests[0]?.status === "completed", `${harness}: the first turn completes`)
    const home = threads.journalPlacement(id)
    assert.ok(home, `${harness}: the conversation has a Session`)
    assert.deepEqual(placementOf(owner, id), { thread: home.thread, session: home.session }, `${harness}: its summary names them`)
    assert.equal(owner.snapshot(id)?.threadId, home.thread, `${harness}: so does its snapshot`)
    expected.set(id, home)

    const forkId = randomUUID()
    const fork = owner.fork(id, { id: forkId, provider: harness, point: { kind: "run", requestId: seed } })
    assert.equal(fork.threadId, home.thread, `${harness}: a fork joins its parent's Thread`)
    assert.notEqual(fork.sessionId, home.session, `${harness}: as its own Session`)
    assert.deepEqual(lastGroup(events, home.thread), [home.session, fork.sessionId], `${harness}: windows hear the Thread's new tab`)
    assert.throws(() => owner.fork(id, { id: forkId, provider: harness, point: { kind: "run", requestId: seed }, thread: "new" }), /another Thread/,
      `${harness}: a fork ID is not reused for the other placement`)
    const apart = owner.fork(id, { id: randomUUID(), provider: harness, point: { kind: "run", requestId: seed }, thread: "new" })
    assert.notEqual(apart.threadId, home.thread, `${harness}: asked for a new Thread, it gets one`)
    const forked = threads.journalPlacement(forkId)
    assert.ok(forked)
    expected.set(forkId, forked)

    const other = HARNESSES[(index + 1) % HARNESSES.length] ?? "codex"
    const tab = threads.createSession({ operationId: randomUUID(), thread: home.thread, actor: threads.person() })
    const tabId = randomUUID()
    await owner.start(other, CWD, { conversationId: tabId, session: tab.session, initialRequest: { id: randomUUID(), text: "from the new tab", attachments: [] } })
    await until(() => owner.snapshot(tabId)?.requests[0]?.status === "completed", `${other}: the new tab's first turn completes`)
    assert.deepEqual(threads.journalPlacement(tabId), tab, `${other}: a new tab's conversation runs in the tab's Session`)
    assert.deepEqual(placementOf(owner, tabId), { thread: home.thread, session: tab.session })
    assert.deepEqual(threads.group(home.thread)?.sessions.map((session) => [session.id, session.started]), [[home.session, true], [forked.session, true], [tab.session, true]])
    expected.set(tabId, tab)

    const splitId = randomUUID()
    const split = owner.splitSessions(splitId, [forked.session])
    const alone = split.placements[0]?.thread
    assert.ok(alone && alone !== home.thread, `${harness}: a split Session gets a new Thread`)
    assert.deepEqual(owner.splitSessions(splitId, [forked.session]), split, `${harness}: a repeated split returns the first new Thread`)
    assert.deepEqual(placementOf(owner, forkId), { thread: alone, session: forked.session }, `${harness}: its summary names the new Thread`)
    assert.equal(owner.snapshot(forkId)?.threadId, alone, `${harness}: so does its snapshot`)
    assert.deepEqual(lastGroup(events, home.thread), [home.session, tab.session], `${harness}: windows hear the tab leave`)
    const heard = events.findLast((event) => event.type === "thread-regroup")
    assert.deepEqual(heard?.type === "thread-regroup" ? heard.regroup : undefined, split, `${harness}: windows hear where the Session went`)

    const apartPlaced = apart.threadId && apart.sessionId ? { thread: apart.threadId, session: apart.sessionId } : undefined
    assert.ok(apartPlaced)
    owner.joinThread(randomUUID(), [forked.session, apartPlaced.session], home.thread)
    const joined = { thread: home.thread, session: forked.session }
    assert.deepEqual(placementOf(owner, forkId), joined, `${harness}: an added Session names the Thread it joined`)
    assert.deepEqual(placementOf(owner, apart.session.id), { thread: home.thread, session: apartPlaced.session })
    assert.deepEqual(lastGroup(events, home.thread), [home.session, tab.session, forked.session, apartPlaced.session], `${harness}: added Sessions are the last tabs`)
    const left = events.findLast((event) => event.type === "thread-group" && event.change.thread === apartPlaced.thread)
    assert.equal(left?.type === "thread-group" ? left.change.group?.id : undefined, home.thread, `${harness}: the Thread they left empty is announced as the one they joined`)
    expected.set(forkId, { thread: home.thread, session: forked.session })
    expected.set(apart.session.id, { thread: home.thread, session: apartPlaced.session })

    await assert.rejects(owner.start(other, CWD, { conversationId: randomUUID(), session: randomUUID() }), /no longer exists/,
      `${other}: a tab whose Session is gone starts nothing`)
  }
  await owner.stop()
  threads.close()

  const reopened = new ThreadStore(storePath, { realPath: (path) => path })
  owner = host(reopened, [])
  for (const [id, placed] of expected) {
    assert.deepEqual(reopened.journalPlacement(id), placed, "a restart places every journal where it was")
    assert.deepEqual(placementOf(owner, id), { thread: placed.thread, session: placed.session }, "and its summary says so")
  }
  await owner.stop()
  reopened.close()
  console.log(`thread groups host: ${HARNESSES.length} harnesses name their Thread, fork into it, start in a new tab, split out and join, stable across restart`)
}

try {
  await main()
} finally {
  rmSync(root, { recursive: true, force: true })
}

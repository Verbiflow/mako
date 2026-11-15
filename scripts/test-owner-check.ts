import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { Git } from "@mako/git"
import type { AccountListHeard } from "@mako/protocol/account-sessions"
import { continueCloudThread, type ContinueState } from "@mako/protocol/continues"
import type { MoveAnswer } from "@mako/protocol/moves"
import type { ListedSession, SessionListings } from "@mako/protocol/thread-listing"
import { followHostLog } from "@mako/host/base/host-log"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { encodeRuntimeValue, type EncodedValue } from "@mako/host/contracts/runtime-value"
import { describeOwnerChecks, SyncRecorder } from "@mako/host/contracts/sync-readings"
import { CloudConversations } from "@mako/host/conversations/cloud-conversations"
import { CloudMoves } from "@mako/host/conversations/cloud-moves"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { ownerHold } from "@mako/host/conversations/owner-check"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { ThreadStore } from "@mako/host/threads/store"
import type { AccountListNotice, CloudAccount } from "@mako/host/usage/cloud-account-methods"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"
import { ranOut } from "./lib/ran-out.ts"

/**
 * A Mac back from away runs nothing of its own Sessions before it hears its account (`OwnerCheck`): `npm run
 * test:owner-check`.
 *
 * One conversation host (`LiveConversations`, its harness a stand-in), the account's list as this Mac hears it
 * (`CloudConversations`, the account a stand-in whose list answers when the case says) and the continue it joins
 * (`CloudMoves`), wired as the host wires them (`ownerHold`). In each case the Mac wakes and the person types before
 * the list has answered:
 * 1. The list says the Session continued in the cloud while the Mac was away: the message runs in the cloud, once,
 *    under its own ID, and nothing of it runs here.
 * 2. No list comes (the Mac is offline): the message runs here once the wait runs out, and not before.
 * 3. The list says the Session is still this Mac's: the message runs here as the list arrives, with no wait beyond it.
 * 4. No wake, but the account's link down on this Mac's side as the person types (the network back between the link's
 *    backoff tries): the link is tried at once, and the message goes where the list it reads says; offline, it runs
 *    here as soon as the try fails.
 * And: a read begun before the account's link opened again isn't the account's word; a list that holds this Mac quiet
 * waits for the account to say it's reachable; Diagnostics says each check.
 */
/** What the host logged, said if a case fails: each decision is a line. */
const logged: string[] = []
followHostLog(({ level, scope, message, fields }) => void logged.push(`${level} ${scope} ${message} ${JSON.stringify(fields ?? {})}`))
/** What the case under way opened. */
const opened: Array<() => void | Promise<void>> = []
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-owner-check-")))
const CWD = join(root, "worktrees", "webhooks")
const git = new Git()
const mac = randomUUID()
const phone = randomUUID()
const accountId = randomUUID()

type Fixture = { driver: ProviderLiveDriver; starts: number; prompts: Array<{ text: string; at: number }> }

/** A harness whose turns end as soon as they start. */
function fixture(owner: () => LiveConversations): Fixture {
  const sessions = new Map<string, LiveSessionState>()
  const state: Fixture = {
    starts: 0,
    prompts: [],
    driver: {
      ...noCapabilities,
      resume: fixtureResume({ checkpoint: async () => "checkpoint", inspect: async () => ({ kind: "available", checkpoint: "checkpoint", strategy: "same-session" }) }),
      approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
      nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
      nativeExclusion: NO_NATIVE_EXCLUSION,
      launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
      nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
      planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
      backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
      turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
      provider: "codex",
      available: () => true,
      start: async (cwd, options) => {
        state.starts += 1
        const session: LiveSessionState = {
          id: options.conversationId, nativeId: options.resume ?? `native-${options.conversationId}`, nativePath: options.resume ? options.threadPath : undefined,
          harness: "codex", cwd, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [],
        }
        sessions.set(options.conversationId, session)
        return session
      },
      prompt: async (id, text, _attachments, _settings, dispatch) => {
        dispatch.report({ kind: "submitted", source: "transport-call" })
        state.prompts.push({ text, at: performance.now() })
        const session = sessions.get(id)
        assert.ok(session, "a prompt goes to a started session")
        owner().observe({ type: "live-session", session: { ...session, status: "running" } })
        owner().observe({ type: "live-session", session })
      },
      permission: async () => {},
      cancel: async () => {},
      setMode: async () => {},
      close: async () => {},
    },
  }
  return state
}

const unasked = (what: string) => async (): Promise<never> => {
  throw new Error(`nothing here ${what}`)
}

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await delay(2)
  assert.ok(check(), what)
}

/** A list the case answers when it says: the read waits on it, as a read after a wake waits on the network. */
function gate<Value>() {
  let open: (value: Value) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const promise = new Promise<Value>((resolve, reject) => {
    open = resolve
    fail = reject
  })
  return { promise, open, fail }
}

/**
 * A Mac with one Session at rest, its first turn done, whose account list was heard; then the Mac is away and wakes,
 * its list read waiting on `list`.
 */
async function world(name: string, ownerCheckMs = { check: 10_000, most: 30_000 }) {
  const folder = join(root, name)
  const threads = new ThreadStore(join(folder, "threads.sqlite"))
  let owner: LiveConversations | undefined
  const self = () => {
    assert.ok(owner)
    return owner
  }
  const fx = fixture(self)
  let router: CloudConversations | undefined
  let moves: CloudMoves | undefined
  owner = new LiveConversations({
    root: join(folder, "journals"), appPath: root, threads, driver: (provider) => (provider === "codex" ? fx.driver : undefined), history: async () => null, emit: () => {},
    nativePath: (session) => (session.nativeId ? join(root, "native", `${session.nativeId}.jsonl`) : undefined),
    checkpoint: async () => "checkpoint", providerIdleMs: 60_000, providerWarmLimit: 20,
    ownerCheck: ownerHold({ account: () => router, moves: () => moves, session: (conversationId) => threads.journalPlacement(conversationId)?.session }),
  })
  const id = randomUUID()
  const seed = randomUUID()
  await owner.start("codex", CWD, { conversationId: id, initialRequest: { id: seed, text: "seed", attachments: [] } })
  await until(() => owner.snapshot(id)?.requests.find((request) => request.id === seed)?.status === "completed", "the first turn completes")
  await until(() => Boolean(owner.snapshot(id)?.control?.bindings[0]?.path), "the binding learns its native path")
  const placed = threads.journalPlacement(id)
  assert.ok(placed)
  const generation = threads.execution(placed.session)!.generation
  const iso = new Date().toISOString()
  const row = (extra: Partial<ListedSession> = {}): ListedSession => ({
    session: placed.session, thread: placed.thread, conversation: id, harness: "codex", state: "idle", folder: CWD, createdAt: iso, activityAt: iso,
    generation, runsOn: { kind: "device", deviceId: mac }, listedAt: iso, ...extra,
  })

  let listing: () => Promise<SessionListings> = async () => ({ sessions: [row()], seq: 1 })
  let reads = 0
  /** The account's link as this Mac's side has it: heard, or down until a try opens it (`reachAccount`). */
  let heard = true
  let reaching: () => Promise<boolean> = async () => true
  let reaches = 0
  const listeners = new Set<(heard: AccountListNotice) => void>()
  const op = randomUUID()
  const cloudThread = await continueCloudThread(op)
  const state: ContinueState = {
    op, thread: placed.thread, from: mac, by: phone, cloudThread, folder: CWD, repository: { url: "https://github.com/ana/api", branch: "webhooks" },
    sessions: [{ session: placed.session, conversation: id, harness: "codex", nativeId: owner.snapshot(id)!.session.nativeId!, generation, folder: CWD }],
    phase: "continued", waiting: [], at: iso, changedAt: iso,
    start: { version: 1, sha256: "a".repeat(64), bytes: 10, head: "b".repeat(40), index: "c".repeat(40), work: "d".repeat(40), branch: "webhooks" },
  }
  const claimed: MoveAnswer = { kind: "claimed", move: op, at: Date.now(), sessions: [{ id: placed.session, generation: generation + 2 }] }
  const account: CloudAccount = {
    token: async () => "made-up",
    gateway: () => undefined,
    id: async () => accountId,
    session: () => { throw new Error("nothing here opens a session") },
    deviceId: async () => mac,
    cloudBlocked: async () => undefined,
    sessionListings: () => (reads++, listing()),
    devices: async () => ({ devices: [], current: mac }),
    accountHeard: () => heard,
    reachAccount: () => (reaches++, reaching()),
    onThreadListings: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    continueState: async () => state,
    moveAnswer: async () => claimed,
    createThread: unasked("makes a cloud Thread"),
    askBases: unasked("asks for a base"),
    sendCheckpoint: unasked("sends a checkpoint"),
    handOverMove: unasked("hands a move over: the account did"),
    refuseMove: unasked("refuses a move"),
    threadRecords: unasked("reads a Thread's records"),
    deviceRecords: unasked("reads a device's records"),
    deviceOriginals: unasked("reads originals"),
    readCheckpoint: unasked("reads a checkpoint"),
    beginReturn: unasked("begins a return"),
    releaseReturn: unasked("releases a return"),
    cancelReturn: unasked("cancels a return"),
    giveBackReturn: unasked("gives back a return"),
    finishReturn: unasked("finishes a return"),
    archiveReturn: unasked("archives a return"),
    returnState: unasked("reads a return"),
    wake: () => undefined,
    stop: () => undefined,
  }
  /** What reached the cloud Thread: each call's channel and arguments, as its machine would take them. */
  const machine: Array<{ channel: string; args: unknown[] }> = []
  const adopted: string[] = []
  const ended = new Set<string>()
  const readings = new SyncRecorder()
  router = new CloudConversations({
    account: () => account, readings, file: join(folder, "conversations.json"), emit: () => {}, repositoryOf: async () => ({ url: "https://github.com/ana/api", branch: "webhooks" }),
    threads: () => threads,
    continued: (session, listed) => moves?.joinContinue(session, listed),
    ownerChecked: () => self().moves.ownerChecked(),
    ownerCheckMs,
  })
  moves = new CloudMoves({
    folder: join(folder, "moves"), git, account: () => account, threads: () => threads, moves: owner.moves,
    snapshot: (conversationId) => self().snapshot(conversationId) ?? null,
    checkout: () => undefined,
    repositoryOf: async () => ({ url: "https://github.com/ana/api", branch: "webhooks" }),
    sendRecords: async () => { throw new Error("a joined continue sends nothing: the account had it all") },
    cloud: {
      adopt: async (conversation) => void adopted.push(conversation.conversationId),
      callThread: async (threadId, channel, args): Promise<EncodedValue> => {
        assert.equal(threadId, cloudThread)
        machine.push({ channel, args: [...args] })
        return encodeRuntimeValue(null)
      },
    },
    live: {
      handOff: async () => undefined, continueTurn: () => undefined,
      waitingPrompts: (conversationId) => self().waitingPrompts(conversationId),
      carried: (conversationId, requestIds, to) => self().carried(conversationId, requestIds, to),
    },
    remembered: () => null,
    step: () => undefined,
    ended: (move) => {
      ended.add(move)
      self().moves.ownerChecked()
    },
    newCloudThread: () => "t-unused",
  })
  opened.push(async () => {
    router.dispose()
    await self().stop()
    threads.close()
  })
  await router.start()
  await until(() => router.ownerCheck() === undefined, "the list at its start is heard")
  const request = (requestId: string): LiveRequest | undefined => self().snapshot(id)?.requests.find((each) => each.id === requestId)
  return {
    owner, fx, router, moves, threads, id, placed, generation, row, op, cloudThread, machine, adopted, ended, request, readings,
    reads: () => reads,
    reaches: () => reaches,
    answer: (next: () => Promise<SessionListings>) => { listing = next },
    link: (isHeard: boolean, reach?: () => Promise<boolean>) => {
      heard = isHeard
      if (reach) reaching = reach
    },
    say: (heard: AccountListNotice) => { for (const listener of listeners) listener(heard) },
    listed: (op: string): NonNullable<ListedSession["continued"]> => ({ op, phase: "continued", from: mac, by: phone, cloudThread, at: iso }),
  }
}

/** A case, its host's lines said if it fails, and what it opened closed as it ends. */
function scenario(name: string, run: () => Promise<void>): void {
  test(name, async () => {
    const from = logged.length
    try {
      await run()
    } catch (error) {
      console.error(logged.slice(from).join("\n"))
      throw error
    } finally {
      for (const close of opened.splice(0)) await close()
    }
  })
}
after(async () => {
  await git.close()
  rmSync(root, { recursive: true, force: true })
})

// 1. The exact race: back from sleep, the person types before the list; the list says the Session continued in the
// cloud meanwhile. The message runs there, once, under its own ID; nothing of it runs here.
scenario("a message typed before the list runs in the cloud, once, when the list says the Session continued there", async () => {
  const w = await world("continued")
  const list = gate<SessionListings>()
  w.answer(() => list.promise)
  w.router.wake()
  const typed = randomUUID()
  const starts = w.fx.starts
  w.owner.submit(w.id, typed, "typed before the list", [])
  await delay(50)
  assert.equal(w.request(typed)?.status, "queued", "it waits for the account")
  assert.ok(w.request(typed)?.ownerCheck, "and says what it waits for")
  assert.ok(!w.fx.prompts.some((prompt) => prompt.text === "typed before the list"), "nothing ran here")
  list.open({ sessions: [w.row({ continued: w.listed(w.op) })], seq: 2 })
  await until(() => w.ended.has(w.op), "the continue is joined")
  const execution = w.threads.execution(w.placed.session)
  assert.equal(execution?.state, "elsewhere", "the Session runs in the cloud now")
  assert.equal(execution?.generation, w.generation + 2, "at the generation the cloud claimed")
  const sent = w.machine.filter((call) => call.channel === "mako:live-prompt")
  assert.equal(sent.length, 1, "the message went to the cloud Thread, once")
  assert.deepEqual(sent[0]!.args.slice(0, 3), [w.id, typed, "typed before the list"], "under its own ID")
  assert.deepEqual(w.request(typed)?.carried?.to, "cloud", "and is marked here as gone with the Thread")
  assert.equal(w.request(typed)?.status, "canceled")
  await delay(50)
  assert.ok(!w.fx.prompts.some((prompt) => prompt.text === "typed before the list"), "nothing of it ran here")
  assert.equal(w.fx.starts, starts, "nor did its harness start here")
  assert.throws(() => w.owner.submit(w.id, randomUUID(), "after", []), /runs on a cloud runtime/, "what follows goes to the cloud")
  // Heard again (the stream says the row once more), nothing more is sent.
  w.say({ seq: 3, event: { type: "sessions-listed", sessions: [w.row({ continued: w.listed(w.op) })] } } satisfies AccountListHeard)
  await delay(30)
  assert.equal(w.machine.filter((call) => call.channel === "mako:live-prompt").length, 1)
})

// 2. Offline: no list comes after the wake. The message waits as long as the check, then runs here once.
scenario("offline, a message waits as long as the check, then runs here once", async () => {
  const w = await world("offline", { check: 300, most: 2_000 })
  w.answer(() => Promise.reject(new Error("The Mako cloud didn't answer")))
  w.router.wake()
  const woke = performance.now()
  const typed = randomUUID()
  w.owner.submit(w.id, typed, "typed offline", [])
  await delay(100)
  assert.equal(w.request(typed)?.status, "queued", "it waits for the account while the check lasts")
  await until(() => w.request(typed)?.status === "completed", "then runs here")
  const ran = w.fx.prompts.filter((prompt) => prompt.text === "typed offline")
  assert.equal(ran.length, 1, "once")
  assert.ok(ran[0]!.at - woke >= 290, `not before the check gave up (${Math.round(ran[0]!.at - woke)} ms)`)
  assert.equal(w.request(typed)?.ownerCheck, undefined, "sent, it no longer says it waits")
  const checks = w.readings.readings().list.ownerChecks
  assert.equal(checks?.at(-1)?.why, "wake")
  assert.equal(checks?.at(-1)?.outcome, "gave-up")
  // Diagnostics report elapsed time: a 300 ms timer can read 299 ms, or seconds on a busy runner.
  assert.match(describeOwnerChecks(checks) ?? "", /^not heard (?:\d+ ms|\d+\.\d s) after this Mac woke, so what waited ran here$/)
})

// 3. Still this Mac's: the message runs here as the list arrives, with no wait beyond it.
scenario("still this Mac's, a message runs here as the list arrives", async () => {
  const w = await world("still-here")
  const list = gate<SessionListings>()
  w.answer(() => list.promise)
  w.router.wake()
  const typed = randomUUID()
  w.owner.submit(w.id, typed, "typed before the list", [])
  await delay(50)
  assert.equal(w.request(typed)?.status, "queued", "it waits for the account")
  const answered = performance.now()
  const { waits } = await ranOut(async () => {
    list.open({ sessions: [w.row()], seq: 2 })
    await until(() => w.fx.prompts.some((prompt) => prompt.text === "typed before the list"), "it runs here")
  })
  const after = w.fx.prompts.find((prompt) => prompt.text === "typed before the list")!.at - answered
  // As the list arrives, by what it waited for rather than the runner's clock: nothing ran out between the two.
  assert.deepEqual(waits, [], `as the list arrives, with no wait beyond it (${after.toFixed(1)} ms after it)`)
  console.log(`  still here: sent ${after.toFixed(1)} ms after the list answered`)
  assert.equal(w.threads.execution(w.placed.session)?.state, "here")
  assert.match(describeOwnerChecks(w.readings.readings().list.ownerChecks) ?? "", /^heard \d+ ms after this Mac woke$/)
})

// A read begun before the account's link opened again isn't the account's word: the list is read once more.
scenario("a read begun before the account's link opened again isn't the account's word", async () => {
  const w = await world("linked")
  const first = gate<SessionListings>()
  w.answer(() => first.promise)
  w.router.wake()
  await until(() => w.reads() === 2, "the wake reads the list")
  const second = gate<SessionListings>()
  w.answer(() => second.promise)
  w.say("linked")
  first.open({ sessions: [w.row()], seq: 2 })
  await until(() => w.reads() === 3, "and reads it again for the link")
  assert.notEqual(w.router.ownerCheck(), undefined, "the first read doesn't end the check")
  second.open({ sessions: [w.row()], seq: 3 })
  await until(() => w.router.ownerCheck() === undefined, "the read after the link does")
})

// A list that holds this Mac quiet (its runtime link isn't back yet) says a continue may begin any moment: the check
// waits for the account to say this Mac is reachable.
scenario("a list holding this Mac quiet waits for the account to say it's reachable", async () => {
  const w = await world("quiet")
  const typed = randomUUID()
  w.answer(async () => ({ sessions: [w.row()], seq: 2, quiet: [{ deviceId: mac, since: new Date().toISOString(), continues: true }] }))
  w.router.wake()
  w.owner.submit(w.id, typed, "typed while quiet", [])
  await until(() => w.reads() === 2, "the list is read")
  await delay(50)
  assert.equal(w.request(typed)?.status, "queued", "quiet, it waits")
  w.say({ seq: 3, event: { type: "device-quiet", deviceId: mac, since: null } })
  await until(() => w.request(typed)?.status === "completed", "reachable, it runs here")
})

// A conversation begun after the wake can't have been continued: it never waits.
scenario("a conversation begun after the wake never waits", async () => {
  const w = await world("new")
  const list = gate<SessionListings>()
  w.answer(() => list.promise)
  w.router.wake()
  const fresh = randomUUID()
  const first = randomUUID()
  await w.owner.start("codex", CWD, { conversationId: fresh, initialRequest: { id: first, text: "a new Thread", attachments: [] } })
  await until(() => w.owner.snapshot(fresh)?.requests.find((request) => request.id === first)?.status === "completed", "it runs at once")
  list.open({ sessions: [w.row()], seq: 2 })
})

// The network came back without a sleep, the account's link still between its backoff's tries: a message typed then
// waits while the link is tried at once, and the list it then reads says the Session continued in the cloud meanwhile.
scenario("a message typed while the account's link is down here waits while it's tried at once, and runs in the cloud when the list says the Session continued there", async () => {
  const w = await world("unheard")
  const reached = gate<boolean>()
  const list = gate<SessionListings>()
  w.link(false, () => reached.promise)
  w.answer(() => list.promise)
  const typed = randomUUID()
  const starts = w.fx.starts
  w.owner.submit(w.id, typed, "typed as the network came back", [])
  await delay(50)
  assert.equal(w.request(typed)?.status, "queued", "it waits for the account")
  assert.ok(w.request(typed)?.ownerCheck, "and says what it waits for")
  assert.equal(w.reaches(), 1, "the link is tried at once")
  w.link(true)
  reached.open(true)
  w.say("linked")
  list.open({ sessions: [w.row({ continued: w.listed(w.op) })], seq: 2 })
  await until(() => w.ended.has(w.op), "the continue is joined")
  const sent = w.machine.filter((call) => call.channel === "mako:live-prompt")
  assert.equal(sent.length, 1, "the message went to the cloud Thread, once")
  assert.deepEqual(sent[0]!.args.slice(0, 3), [w.id, typed, "typed as the network came back"], "under its own ID")
  await delay(50)
  assert.ok(!w.fx.prompts.some((prompt) => prompt.text === "typed as the network came back"), "nothing of it ran here")
  assert.equal(w.fx.starts, starts, "nor did its harness start here")
  assert.match(describeOwnerChecks(w.readings.readings().list.ownerChecks) ?? "", /^heard \d+ ms after a message while the account's link was down$/)
})

// Offline: the link tried at once can't open, so the message runs here then, not after the check's bound; and the next
// one tries the link again, once.
scenario("offline, a message typed while the account's link is down runs here as soon as the link can't open", async () => {
  const w = await world("unreached", { check: 5_000, most: 10_000 })
  w.link(false, async () => false)
  const typed = randomUUID()
  const sent = performance.now()
  const { waits: offlineWaits } = await ranOut(async () => {
    w.owner.submit(w.id, typed, "typed offline", [])
    await until(() => w.request(typed)?.status === "completed", "it runs here")
  })
  const ran = w.fx.prompts.filter((prompt) => prompt.text === "typed offline")
  assert.equal(ran.length, 1, "once")
  assert.ok(offlineWaits.every((ms) => ms < 1_000), `as the link couldn't open, not after the check's bound (${Math.round(ran[0]!.at - sent)} ms; ran out: ${offlineWaits.join(", ")})`)
  assert.equal(w.reaches(), 1)
  assert.match(describeOwnerChecks(w.readings.readings().list.ownerChecks) ?? "", /^not heard \d+ ms after a message while the account's link was down, so what waited ran here$/)
  const next = randomUUID()
  w.owner.submit(w.id, next, "typed offline again", [])
  await until(() => w.request(next)?.status === "completed", "the next runs here too")
  assert.equal(w.reaches(), 2, "having tried the link once more")
})

// The account's link heard: a message runs at once, and the link isn't tried.
scenario("with the account's link heard, a message runs at once and nothing is tried", async () => {
  const w = await world("heard")
  const typed = randomUUID()
  w.owner.submit(w.id, typed, "typed online", [])
  await until(() => w.request(typed)?.status === "completed", "it runs here")
  assert.equal(w.reaches(), 0)
  assert.equal(w.request(typed)?.ownerCheck, undefined, "it never waited")
})

// Signed out: there's no account to hear, and nothing waits.
scenario("signed out, nothing waits", async () => {
  const router = new CloudConversations({ account: () => undefined, file: join(root, "signed-out.json"), emit: () => {}, repositoryOf: async () => ({ url: "https://github.com/ana/api" }) })
  assert.notEqual(router.ownerCheck(), undefined, "until it starts, the host may have been away")
  await router.start()
  assert.equal(router.ownerCheck(), undefined)
  router.dispose()
})

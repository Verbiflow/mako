import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, connect, type AddressInfo, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { WebSocketServer } from "ws"
import {
  PING,
  PONG,
  PROTOCOL_VERSION,
  Payload,
  RuntimeThreads,
  problem,
  clientSessionOverSockets,
  decodeClientFrame,
  encodeGatewayClientFrame,
  type ClientSession,
  type ClientSessionOverSockets,
  type Subscription,
} from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { Git } from "@mako/git"
import { CloudConversations, folderRepository, type CloudConversationsOptions, type CloudCopies } from "@mako/host/conversations/cloud-conversations"
import type { WaitingMessage } from "@mako/protocol/waiting"
import { cloudRuntimeOf, namedUuid } from "@mako/host/conversations/cloud-moves"
import { MoveIdSchema, type RuntimeId } from "@mako/host/contracts/thread-execution"
import { SessionIdSchema, type ThreadId } from "@mako/host/contracts/thread-identity"
import { ThreadStore } from "@mako/host/threads/store"
import type { CloudPrepareLaunch, CloudRepository } from "@mako/host/contracts/cloud-threads"
import { githubRepositoryUrl } from "@mako/host/contracts/cloud-threads"
import { decodeRuntimeEvent, decodeRuntimeValue, encodeRuntimeEvent, encodeRuntimeValue, runtimeEventLine, type RuntimeEvent } from "@mako/host/contracts/runtime-value"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { ThreadAppView } from "@mako/host/contracts/thread-app"
import type { LiveBatch } from "@mako/host/contracts/live-conversations"
import { TURN_CHANGES_VERSION } from "@mako/host/contracts/turn-changes"
import { followHostLog } from "@mako/host/base/host-log"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"
import type { CloudAccount } from "@mako/host/usage/cloud-account-methods"
import type { AccountListHeard } from "@mako/protocol/account-sessions"
import type { ListedSession, ListedState, SessionListings } from "@mako/protocol/thread-listing"
import { z } from "zod"

/** A move's calls and its way back's, which these conversations never make (`test-cloud-moves.ts` covers them). */
const unused = () => Promise.reject(new Error("no move in this test"))
const movesUnused: Pick<CloudAccount, "sendCheckpoint" | "handOverMove" | "refuseMove" | "moveAnswer" | "threadRecords" | "deviceRecords" | "deviceOriginals" | "readCheckpoint" | "beginReturn" | "releaseReturn" | "cancelReturn" | "giveBackReturn" | "finishReturn" | "archiveReturn" | "returnState"> = {
  sendCheckpoint: unused,
  handOverMove: unused,
  refuseMove: unused,
  moveAnswer: unused,
  threadRecords: unused,
  deviceRecords: unused,
  deviceOriginals: unused,
  readCheckpoint: unused,
  beginReturn: unused,
  releaseReturn: unused,
  cancelReturn: unused,
  giveBackReturn: unused,
  finishReturn: unused,
  archiveReturn: unused,
  returnState: unused,
}

const CLONE = "/home/node/work/octocat/Hello-World"
const REPOSITORY: CloudRepository = { url: "https://github.com/octocat/Hello-World" }
const scratch = await mkdtemp(join(tmpdir(), "mako-cloud-conversations-"))
after(() => rm(scratch, { recursive: true, force: true }))

/** How this Mac reaches the cloud: in memory, or over real sockets that can go silent as a sleeping Mac's do. */
type Reach = { sockets?: { heartbeatMs: number; silentMs?: number; wakeProbeMs?: number } }

/** One Thread the cloud was asked to make. */
interface Ask {
  threadId: string
  prepare: boolean
  harness?: string
}

/**
 * Where the stand-in machine's store files the next forks: in the Session the device named, as a current host does;
 * or, as a host on an older image did, ignoring it, in `into` or a Session of its own.
 */
type ForkFiling = { into: string | undefined; older: boolean }

/** What a stand-in machine's host answers a look at its folder's app. */
interface MachineApp {
  view: ThreadAppView
}

/** A cloud machine's host behind the fake gateway: what it was asked, and its Thread's event outbox. */
async function cloudMachine(reach: Reach = {}) {
  const gateway = createFakeGateway()
  const runtimeId = "m-0123456789abcdef.g1"
  const threads = new RuntimeThreads()
  const calls: Array<{ channel: string; args: unknown[] }> = []
  /** By fork: the Session the machine's store put it in. */
  const forkSessions = new Map<string, string>()
  /** Set to make the machine's store file the next forks into this Session, as one was seen to (its parent's). */
  const filing: ForkFiling = { into: undefined, older: false }
  const app: MachineApp = { view: { kind: "ready", project: "Hello-World", phase: "running", address: { host: "t.thread.localhost", port: 20000 }, processes: [], checks: [] } }
  const host: Parameters<typeof serveHostThroughGateway>[1] = {
    runtimeId,
    build: "test",
    threads,
    invoke: async (channel, args) => {
      calls.push({ channel, args })
      if (channel === "mako:boot") return JSON.stringify({ activeTabId: "tab-1", tabs: [{ id: "tab-1", session: { meta: { cwd: CLONE } } }] })
      if (channel === "mako:thread-app") return JSON.stringify(app.view)
      if (channel === "mako:live-start") {
        const [harness, cwd, options] = z.tuple([z.string(), z.string(), z.object({ conversationId: z.string(), session: z.string().optional() }).loose()]).parse(args)
        return JSON.stringify({ session: { id: options.conversationId, harness, cwd, status: "running" }, revision: 1, createdAt: 1, requests: [], ...options.session && { sessionId: options.session } })
      }
      // The machine's store takes a `+` tab's Session under the device's ID, and puts a fork in one of its own.
      if (channel === "mako:thread-create-session") return JSON.stringify({ thread: args[1], session: args[2] })
      if (channel === "mako:live-fork") {
        const input = z.object({ id: z.string(), provider: z.string(), session: z.string().optional() }).loose().parse(args[1])
        const session = (!filing.older && input.session) || (filing.into ?? randomUUID())
        forkSessions.set(input.id, session)
        return JSON.stringify({ session: { id: input.id, harness: input.provider, cwd: CLONE, status: "ready" }, revision: 1, createdAt: 1, requests: [], sessionId: session })
      }
      return JSON.stringify({ channel })
    },
  }
  const served = await serveHostThroughGateway(await gateway.connectRuntime(), host)
  after(() => served.close())
  /** The machine woken from its pause: its host serves the Thread again. */
  const wake = async () => {
    const again = await serveHostThroughGateway(await gateway.connectRuntime(), host)
    after(() => again.close())
    return again
  }
  const deviceId = randomUUID()
  const client = await gateway.connectClient({ kind: "client", client: "desktop", deviceId })
  const network = reach.sockets ? await sleepyNetwork(gateway, deviceId) : undefined
  const created: string[] = []
  /** Each ask to make a Thread, made ahead or not; and whether one made ahead answers that its machine is ready. */
  const asked: Ask[] = []
  const machineState = { ready: true }
  /** Repositories asked for project bases. */
  const bases: CloudRepository[] = []
  const account: CloudAccount = {
    token: async () => "token",
    gateway: () => new URL("http://gateway.invalid"),
    id: async () => "account",
    deviceId: async () => deviceId,
    session: () =>
      network && reach.sockets
        ? clientSessionOverSockets(() => new WebSocket(network.url), reach.sockets)
        : sessionOf(client),
    createThread: async (threadId, repository, options) => {
      assert.deepEqual(repository, REPOSITORY)
      const ask: Ask = { threadId, prepare: options?.prepare === true }
      if (options?.harness) ask.harness = options.harness
      asked.push(ask)
      if (!created.includes(threadId)) {
        created.push(threadId)
        await gateway.assign(threadId, runtimeId)
      }
      return { ready: options?.prepare ? machineState.ready : false }
    },
    askBases: async (repositories) => void bases.push(...repositories),
    ...movesUnused,
    wake: () => {},
    stop: () => {},
  }
  /** One of the machine host's live batches, on its Thread's stream as the machine sends it. */
  const batch = (threadId: string, conversation: string, revision: number, status: string, more: Pick<LiveBatch, "requests" | "requestChanges"> = {}) => {
    // SAFETY: a batch as the machine's live driver sends it, filled only as far as the router and summary read it.
    const event = encodeRuntimeEvent({ type: "live-batch", batch: { id: conversation, revision, updates: [], sessionChanges: { status }, ...more } } as never)
    return threads.emit(threadId, Payload.encoded(runtimeEventLine("event", event).slice(0, -1)))
  }
  return { account, calls, created, asked, machineState, bases, batch, network, served, wake, app, forkSessions, filing, gateway }
}

/**
 * The fake gateway's client sessions served over WebSockets, as the cloud serves them, behind a TCP proxy. `sleep`
 * stops every open connection's bytes both ways without closing it: a Mac woken on a network the sleep didn't keep
 * holds sockets that look open and never hear another byte. Connections opened after it pass.
 */
async function sleepyNetwork(gateway: ReturnType<typeof createFakeGateway>, deviceId: string) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await once(wss, "listening")
  wss.on("connection", (ws) => {
    const session = gateway.connectClient({ kind: "client", client: "desktop", deviceId })
    const subscriptions = new Map<string, Subscription>()
    ws.on("message", async (data) => {
      const text = String(data)
      // Answered by the edge, as the cloud's is.
      if (text === PING) return ws.send(PONG)
      const frame = decodeClientFrame(text)
      const client = await session
      if (frame.type === "call") ws.send(encodeGatewayClientFrame({ type: "reply", reply: await client.call(frame.operation) }))
      else if (frame.type === "subscribe") {
        const subscription = client.subscribe({ stream: frame.stream, after: frame.after })
        subscriptions.set(frame.stream, subscription)
        void (async () => {
          for (;;) {
            const event = await subscription.next().catch(() => undefined)
            if (!event) return
            if (ws.readyState === ws.OPEN) ws.send(encodeGatewayClientFrame({ type: "event", event }))
          }
        })()
      } else if (frame.type === "unsubscribe") subscriptions.get(frame.stream)?.close()
    })
    ws.on("close", () => {
      for (const subscription of subscriptions.values()) subscription.close()
    })
  })
  // SAFETY: listening on a TCP host and port, so the address is an AddressInfo.
  const upstreamPort = (wss.address() as AddressInfo).port
  const pairs = new Set<{ near: Socket; far: Socket; asleep: boolean }>()
  const proxy = createServer((near) => {
    const pair = { near, far: connect(upstreamPort, "127.0.0.1"), asleep: false }
    pairs.add(pair)
    near.on("data", (chunk) => pair.asleep || pair.far.write(chunk))
    pair.far.on("data", (chunk) => pair.asleep || near.write(chunk))
    const end = () => {
      pairs.delete(pair)
      near.destroy()
      pair.far.destroy()
    }
    for (const socket of [near, pair.far]) {
      socket.on("close", end)
      socket.on("error", end)
    }
  })
  proxy.listen(0, "127.0.0.1")
  await once(proxy, "listening")
  after(() => {
    for (const pair of pairs) {
      pair.near.destroy()
      pair.far.destroy()
    }
    proxy.close()
    wss.close()
  })
  // SAFETY: as above.
  const url = `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}/`
  return {
    url,
    sleep: () => {
      for (const pair of pairs) pair.asleep = true
    },
    open: () => [...pairs].filter((pair) => !pair.asleep).length,
  }
}

/** The fake gateway's client session as the account's session is: opened at once, used as it opens. */
function sessionOf(client: ClientSession): ClientSessionOverSockets {
  return {
    call: (operation) => client.call(operation),
    subscribe: (request): Subscription => client.subscribe(request),
    watch: (request) => client.watch(request),
    close: () => {},
    wake: () => {},
  }
}

/** The router, the conversations' events it relays, and apart from them, what it tells windows of each start. */
function conversations(account: CloudAccount, file: string, copies?: CloudCopies, asleepMs?: number) {
  const events: RuntimeEvent[] = []
  /** The archived cloud Threads each time the host was told of them, by their IDs. */
  const archived: string[][] = []
  const starts: RuntimeEvent[] = []
  /** Each conversation a window on its folder was told changed, in order. */
  const changed: string[] = []
  /** Each turn end heard, as `<conversation> <Thread>`. */
  const ended: string[] = []
  const options: CloudConversationsOptions = { account: () => account, file, emit: (event) => (event.type === "cloud-start-step" ? starts : events).push(event), repositoryOf: async () => REPOSITORY, changed: (id) => changed.push(id), turnEnded: (conversation, thread) => ended.push(`${conversation} ${thread}`) }
  if (copies) options.copies = copies
  if (asleepMs) options.asleepMs = asleepMs
  options.archivedChanged = (_account, threads) => archived.push([...threads.keys()])
  const router = new CloudConversations(options)
  after(() => router.dispose())
  return { router, events, starts, changed, archived, ended }
}

async function until(what: string, check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("a cloud start makes the Thread once, starts on the machine in its clone, and relays the conversation's events", async () => {
  const machine = await cloudMachine()
  const file = join(scratch, "start", "conversations.json")
  const { router, events } = conversations(machine.account, file)
  const conversationId = randomUUID()
  const options = { conversationId, cloud: { repository: REPOSITORY }, worktree: true, threadPath: "/Users/me/x.jsonl", initialRequest: { id: "r-1", text: "hi", attachments: [] } }
  const started = await router.route("mako:live-start", ["claude", "/Users/me/project", options])
  assert.ok(started.handled)
  assert.equal(z.object({ session: z.object({ id: z.string() }) }).parse(decodeRuntimeValue(started.value)).session.id, conversationId)
  const start = machine.calls.find((call) => call.channel === "mako:live-start")
  assert.equal(start?.args[1], CLONE, "the turn runs in the machine's clone, not this Mac's folder")
  const sent = z.object({ initialRequest: z.unknown() }).loose().parse(start?.args[2])
  for (const key of ["cloud", "worktree", "threadPath"]) assert.equal(key in sent, false, `${key} stays on this Mac`)
  assert.deepEqual(sent.initialRequest, options.initialRequest)
  assert.equal(machine.asked[0]?.harness, "claude", "the Thread is made naming its harness, whose start its machine runs ahead as it boots")

  await router.route("mako:live-start", ["claude", "/Users/me/project", options])
  assert.equal(machine.created.length, 1, "a repeated start makes no second Thread")

  const [threadId] = machine.created
  machine.batch(threadId!, conversationId, 2, "ready")
  machine.batch(threadId!, "another-conversation", 1, "ready")
  await until("the batch relayed", () => events.length === 1)
  assert.equal(events[0]?.conversation, conversationId)
  assert.equal(JSON.parse(events[0]!.payload).batch.revision, 2)
  await until("the summary updated", () => router.summaries()[0]?.session.status === "ready")
  assert.equal(router.summaries()[0]?.revision, 2)

  const prompted = await router.route("mako:live-prompt", [conversationId, "r-2", "again", [], undefined])
  assert.ok(prompted.handled)
  assert.ok(machine.calls.some((call) => call.channel === "mako:live-prompt" && call.args[0] === conversationId))
  assert.equal((await router.route("mako:live-prompt", ["not-a-cloud-one", "r-3", "x", [], undefined])).handled, false)
  assert.equal((await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId: randomUUID() }])).handled, false, "a start without cloud is this Mac's")
})

test("a cloud turn's end is heard once however its batches fell: the session stopping, a request ending in a batch of its own, never a list restated", async () => {
  const machine = await cloudMachine()
  const { router, events, ended } = conversations(machine.account, join(scratch, "turn-ends", "conversations.json"))
  const conversationId = randomUUID()
  await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId, cloud: { repository: REPOSITORY }, initialRequest: { id: "r-1", text: "hi", attachments: [] } }])
  const [threadId] = machine.created
  const heard = `${conversationId} ${threadId}`
  machine.batch(threadId!, conversationId, 2, "running")
  machine.batch(threadId!, conversationId, 3, "ready")
  await until("both batches relayed", () => events.length === 2)
  assert.deepEqual(ended, [heard], "the session stopped running: its turn ended")
  // A turn begun and ended between two batches this Mac heard: only its request says so.
  machine.batch(threadId!, conversationId, 4, "ready", { requestChanges: [{ id: "r-2", text: "again", attachments: [], status: "completed" }] })
  await until("the request's end relayed", () => events.length === 3)
  assert.deepEqual(ended, [heard, heard], "a request that ended is a turn that ended")
  machine.batch(threadId!, conversationId, 5, "ready", { requestChanges: [{ id: "r-3", text: "more", attachments: [], status: "dispatching" }] })
  machine.batch(threadId!, conversationId, 6, "ready", { requests: [{ id: "r-2", text: "again", attachments: [], status: "completed" }] })
  await until("both relayed", () => events.length === 5)
  assert.deepEqual(ended, [heard, heard], "a request still at work, or a list restating one that ended long ago, ends nothing")
  // A turn as most fall: running, its request ended, then the session stops: one end, not two.
  machine.batch(threadId!, conversationId, 7, "running")
  machine.batch(threadId!, conversationId, 8, "running", { requestChanges: [{ id: "r-3", text: "more", attachments: [], status: "completed" }] })
  machine.batch(threadId!, conversationId, 9, "ready")
  await until("the turn relayed", () => events.length === 8)
  assert.deepEqual(ended, [heard, heard, heard], "the session stopping after its request's end says nothing more")
  // Its request changed again after its end (what its turn changed, counted then): the same end, not another.
  machine.batch(threadId!, conversationId, 10, "ready", { requestChanges: [{ id: "r-3", text: "more", attachments: [], status: "completed", changes: { version: TURN_CHANGES_VERSION, state: "pending" } }] })
  await until("the change relayed", () => events.length === 9)
  assert.deepEqual(ended, [heard, heard, heard], "a request already ended, changed again, ends nothing")
})

/** The steps a new cloud conversation's window was told, in order. */
function steps(starts: RuntimeEvent[], conversationId: string) {
  return starts
    .map((event) => z.object({ conversationId: z.string(), step: z.string(), project: z.string() }).parse(JSON.parse(event.payload)))
    .filter((step) => step.conversationId === conversationId)
    .map((step) => `${step.step} ${step.project}`)
}

async function prepare(router: CloudConversations, composingMs = 0, launch?: CloudPrepareLaunch) {
  const routed = await router.route("mako:cloud-prepare", ["/Users/me/project", composingMs, launch])
  assert.ok(routed.handled, "the cloud router answers every prepare")
  return decodeRuntimeValue(routed.value)
}

test("writing a new cloud conversation makes its Thread ahead, once, asked again as the person writes; the first message takes it up and starts the harness at once", async () => {
  const machine = await cloudMachine()
  const { router, starts } = conversations(machine.account, join(scratch, "ahead", "conversations.json"))
  assert.equal(await prepare(router), "ready")
  assert.equal(await prepare(router), "ready")
  assert.equal(machine.created.length, 1, "one Thread for the draft, however often it's asked")
  assert.deepEqual(machine.asked.map((ask) => ask.prepare), [true, true])
  const conversationId = randomUUID()
  await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId, cloud: {} }])
  assert.equal(machine.created.length, 1, "the message starts in the Thread made ahead")
  assert.equal(machine.asked.length, 2, "and asks the cloud for nothing more before it goes to the machine")
  assert.deepEqual(steps(starts, conversationId), ["starting Hello-World"], "ready: straight to the harness starting")
  // Taken up, the next draft makes a Thread of its own.
  await prepare(router)
  assert.equal(machine.created.length, 2)
})

test("a start whose machine isn't ready says its project is being got ready, then that the harness starts; with nothing made ahead, it makes its Thread then", async () => {
  const machine = await cloudMachine()
  machine.machineState.ready = false
  const { router, starts } = conversations(machine.account, join(scratch, "not-ready", "conversations.json"))
  assert.equal(await prepare(router), "preparing")
  const ahead = randomUUID()
  await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId: ahead, cloud: {} }])
  assert.deepEqual(steps(starts, ahead), ["preparing Hello-World", "starting Hello-World"])
  const cold = randomUUID()
  await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId: cold, cloud: {} }])
  assert.deepEqual(steps(starts, cold), ["preparing Hello-World", "starting Hello-World"])
  assert.deepEqual(machine.asked.map((ask) => ask.prepare), [true, false], "the second made its Thread as it started")
})

test("a Thread made ahead and left alone isn't taken up; after three in a row go unused, the next waits for ten seconds of writing", async (t) => {
  const machine = await cloudMachine()
  const { router } = conversations(machine.account, join(scratch, "unused", "conversations.json"))
  let now = Date.parse("2026-10-20T06:00:00.000Z")
  t.mock.method(Date, "now", () => now)
  const threadOf = () => machine.asked.at(-1)!.threadId
  await prepare(router)
  const first = threadOf()
  for (let unused = 1; unused < 3; unused++) {
    now += 26 * 60_000
    await prepare(router)
  }
  assert.equal(new Set(machine.asked.map((ask) => ask.threadId)).size, 3, "each left past the cloud's half hour is replaced")
  assert.notEqual(threadOf(), first)
  now += 26 * 60_000
  assert.equal(await prepare(router, 2_000), "later", "three unused: a few seconds of writing isn't enough")
  assert.equal(await prepare(router, 12_000), "ready")
  const conversationId = randomUUID()
  await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId, cloud: {} }])
  assert.equal(await prepare(router, 0), "ready", "one taken up, the first keystroke is enough again")
})

/** Each operation this Mac sent its cloud Thread, by name, and whether it was made ahead of a person's message. */
function recordOperations(machine: Awaited<ReturnType<typeof cloudMachine>>) {
  const sent: Array<{ op: string; ahead: boolean }> = []
  const session = machine.account.session
  machine.account.session = () => {
    const opened = session()
    return { ...opened, call: (operation) => (sent.push({ op: operation.op, ahead: operation.ahead === true }), opened.call(operation)) }
  }
  return sent
}

test("once its machine is ready, the composer's harness is started ahead with no message; the send brings the message to it, and the window takes it up", async () => {
  const machine = await cloudMachine()
  const sent = recordOperations(machine)
  const { router, starts } = conversations(machine.account, join(scratch, "harness-ahead", "conversations.json"))
  const launch = { harness: "claude", modeId: "default", tuning: { model: "opus" } }
  assert.equal(await prepare(router, 0, launch), "ready")
  assert.equal(machine.asked[0]?.harness, "claude", "a Thread made ahead names the composer's harness too")
  await until("the harness started ahead", () => machine.calls.some((call) => call.channel === "mako:live-start"))
  const ahead = z.tuple([z.string(), z.string(), z.object({ conversationId: z.string(), modeId: z.string(), tuning: z.unknown() }).strict()]).parse(machine.calls.find((call) => call.channel === "mako:live-start")?.args)
  assert.equal(ahead[1], CLONE)
  assert.deepEqual(sent.map((call) => `${call.op}${call.ahead ? " ahead" : ""}`), ["host.boot ahead", "host.live-start ahead"], "made ahead: the Thread stays so until the message")
  await prepare(router, 30_000, launch)
  assert.equal(machine.calls.filter((call) => call.channel === "mako:live-start").length, 1, "asked again with the same choice, it isn't started again")

  const key = randomUUID()
  const first = { id: "r-1", text: "the first message", attachments: [] }
  const started = await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId: key, cloud: {}, modeId: "default", tuning: { model: "opus" }, initialRequest: first }])
  assert.ok(started.handled)
  const answered = z.object({ session: z.object({ id: z.string() }) }).parse(decodeRuntimeValue(started.value))
  assert.equal(answered.session.id, ahead[2].conversationId, "the window takes up the conversation started ahead")
  const brought = machine.calls.filter((call) => call.channel === "mako:live-start").at(-1)
  assert.equal(z.object({ conversationId: z.string(), initialRequest: z.unknown() }).loose().parse(brought?.args[2]).conversationId, ahead[2].conversationId)
  assert.equal(machine.calls.filter((call) => call.channel === "mako:boot").length, 1, "the send asks nothing more of the machine first")
  assert.deepEqual(sent.slice(2).map((call) => `${call.op}${call.ahead ? " ahead" : ""}`), ["host.live-start"], "the send's own start takes the Thread up")
  assert.deepEqual(steps(starts, key), ["starting Hello-World"])
  await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId: key, cloud: {}, modeId: "default", tuning: { model: "opus" }, initialRequest: first }])
  assert.equal(machine.created.length, 1, "a repeated start finds it by the window's own ID")
})

test("a Thread made ahead whose machine is still coming up is asked again until it's ready, and its harness starts then, not at the composer's next ask", async () => {
  const machine = await cloudMachine()
  machine.machineState.ready = false
  const { router } = conversations(machine.account, join(scratch, "watch-ready", "conversations.json"))
  assert.equal(await prepare(router, 0, { harness: "claude" }), "preparing")
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  assert.equal(machine.calls.some((call) => call.channel === "mako:live-start"), false, "not ready: nothing started")
  assert.ok(machine.asked.length >= 2, "asked again while it comes up")
  machine.machineState.ready = true
  await until("the harness started once the machine was ready", () => machine.calls.some((call) => call.channel === "mako:live-start"), 5_000)
})

test("a send whose harness changed since one was started ahead closes that one and starts its own, on the machine already ready", async () => {
  const machine = await cloudMachine()
  const { router } = conversations(machine.account, join(scratch, "harness-changed", "conversations.json"))
  await prepare(router, 0, { harness: "claude" })
  await until("the harness started ahead", () => machine.calls.some((call) => call.channel === "mako:live-start"))
  const aheadId = z.object({ conversationId: z.string() }).loose().parse(machine.calls.find((call) => call.channel === "mako:live-start")?.args[2]).conversationId
  const key = randomUUID()
  const started = await router.route("mako:live-start", ["codex", "/Users/me/project", { conversationId: key, cloud: {}, initialRequest: { id: "r-1", text: "hi", attachments: [] } }])
  assert.ok(started.handled)
  assert.equal(z.object({ session: z.object({ id: z.string(), harness: z.string() }) }).parse(decodeRuntimeValue(started.value)).session.id, key)
  await until("the one started ahead closed", () => machine.calls.some((call) => call.channel === "mako:live-close" && call.args[0] === aheadId))
  assert.equal(machine.created.length, 1, "in the same Thread")
})

test("onboarding offers this Mac's recent projects for project bases once per account, each repository once", async () => {
  const machine = await cloudMachine()
  const file = join(scratch, "onboarding", "conversations.json")
  const router = new CloudConversations({
    account: () => machine.account,
    file,
    emit: () => {},
    repositoryOf: async (folder) => (folder.includes("not-github") ? Promise.reject(new Error("not GitHub")) : folder.endsWith("mako") ? REPOSITORY : { url: "https://github.com/octocat/Spoon-Knife" }),
  })
  after(() => router.dispose())
  const offer = async (folders: string[]) => {
    const routed = await router.route("mako:cloud-offer-projects", [folders])
    assert.ok(routed.handled)
    return decodeRuntimeValue(routed.value)
  }
  assert.equal(await offer(["/Users/me/mako", "/Users/me/worktree-of-mako", "/Users/me/not-github", "/Users/me/spoon"]), "asked")
  assert.deepEqual(machine.bases, [REPOSITORY, { url: "https://github.com/octocat/Spoon-Knife" }], "each repository once, newest first; a folder off GitHub is left out")
  assert.equal(await offer(["/Users/me/mako"]), "already", "once per account on this Mac")
  assert.equal(machine.bases.length, 2)
  const accountId = await machine.account.id()
  assert.ok(accountId)
  assert.deepEqual(await router.offeredProjects(accountId), [
    { folder: "/Users/me/mako", repository: REPOSITORY },
    { folder: "/Users/me/spoon", repository: { url: "https://github.com/octocat/Spoon-Knife" } },
  ], "which projects were offered, for turning the cloud on to follow")
  // Offered by a build that didn't keep which: they're noted at the next offer, without asking again.
  await writeFile(join(scratch, "onboarding", "projects-offered.json"), `${JSON.stringify({ accounts: [accountId] })}\n`)
  assert.equal(await router.offeredProjects(accountId), undefined, "not known yet, rather than none")
  assert.equal(await offer(["/Users/me/spoon"]), "already")
  assert.deepEqual(await router.offeredProjects(accountId), [{ folder: "/Users/me/spoon", repository: { url: "https://github.com/octocat/Spoon-Knife" } }])
  assert.equal(machine.bases.length, 2, "nothing asked again")
})

test("a Mac that isn't signed in makes nothing ahead", async () => {
  const router = new CloudConversations({ account: () => undefined, file: join(scratch, "signed-out", "conversations.json"), emit: () => {}, repositoryOf: async () => REPOSITORY })
  after(() => router.dispose())
  assert.equal(await prepare(router), "none")
})

test("a call the gateway lost on its way to the machine is repeated under its one id, and runs once", async () => {
  const machine = await cloudMachine()
  // The first send of a message is lost between the gateway and the machine: its link changed under it, as a machine
  // that woke from a pause replaces a connection that didn't survive.
  const session = machine.account.session
  let lost = 0
  machine.account.session = () => {
    const opened = session()
    return {
      ...opened,
      call: async (operation) =>
        operation.op === "host.live-prompt" && lost++ === 0
          ? { v: PROTOCOL_VERSION, id: operation.id, ok: false as const, problem: problem("owner-unavailable", "The runtime's link failed while the operation was sent", operation.correlationId, "unknown", { status: 503 }) }
          : opened.call(operation),
    }
  }
  const { router } = conversations(machine.account, join(scratch, "lost", "conversations.json"))
  const conversationId = randomUUID()
  await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId, cloud: { repository: REPOSITORY } }])
  const prompted = await router.route("mako:live-prompt", [conversationId, "r-lost", "after a pause", [], undefined])
  assert.ok(prompted.handled, "the window never heard of the loss")
  assert.equal(lost, 2, "sent twice: lost once, then delivered")
  assert.equal(machine.calls.filter((call) => call.channel === "mako:live-prompt").length, 1, "and run once")
})

test("a close is taken at once while nothing runs the Thread, and reaches the machine when it's back", async () => {
  const gateway = createFakeGateway()
  const runtimeId = "m-0123456789abcdef.g1"
  const calls: string[] = []
  const serve = async () =>
    serveHostThroughGateway(await gateway.connectRuntime(), {
      runtimeId,
      build: "test",
      threads: new RuntimeThreads(),
      invoke: async (channel, args) => {
        calls.push(channel)
        if (channel === "mako:boot") return JSON.stringify({ activeTabId: "tab-1", tabs: [{ id: "tab-1", session: { meta: { cwd: CLONE } } }] })
        if (channel === "mako:live-start") return JSON.stringify({ session: { id: z.object({ conversationId: z.string() }).loose().parse(args[2]).conversationId, harness: "claude", cwd: CLONE, status: "running" }, revision: 1, createdAt: 1, requests: [] })
        return JSON.stringify(null)
      },
    })
  let served = await serve()
  const deviceId = randomUUID()
  const client = await gateway.connectClient({ kind: "client", client: "desktop", deviceId })
  const created: string[] = []
  const account: CloudAccount = {
    token: async () => "token",
    gateway: () => new URL("http://gateway.invalid"),
    id: async () => "account",
    deviceId: async () => deviceId,
    session: () => sessionOf(client),
    createThread: async (threadId) => {
      created.push(threadId)
      await gateway.assign(threadId, runtimeId)
      return { ready: false }
    },
    askBases: async () => {},
    ...movesUnused,
    wake: () => {},
    stop: () => {},
  }
  const { router } = conversations(account, join(scratch, "deferred", "conversations.json"))
  const conversationId = randomUUID()
  await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId, cloud: { repository: REPOSITORY } }])
  // The machine sleeps: nothing runs the Thread.
  served.close()
  await until("the runtime gone", () => gateway.deferred(created[0]!).length === 0)
  const closing = await router.route("mako:live-close", [conversationId])
  assert.ok(closing.handled, "answered at once, without waiting on a machine")
  assert.equal(calls.includes("mako:live-close"), false)
  assert.equal(gateway.deferred(created[0]!).length, 1)
  served = await serve()
  after(() => served.close())
  await until("the close delivered once the machine is back", () => calls.includes("mako:live-close"))
  assert.equal(calls.filter((call) => call === "mako:live-close").length, 1)
})

test("a Mac that restarts lists its cloud conversations and follows each from the last event it relayed", async () => {
  const machine = await cloudMachine()
  const file = join(scratch, "restart", "conversations.json")
  const first = conversations(machine.account, file)
  const conversationId = randomUUID()
  await first.router.route("mako:live-start", ["codex", "/Users/me/project", { conversationId, cloud: { repository: REPOSITORY } }])
  const [threadId] = machine.created
  machine.batch(threadId!, conversationId, 2, "running")
  await until("the first batch", () => first.events.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  first.router.dispose()

  // While this Mac was away, the turn finished on the machine.
  machine.batch(threadId!, conversationId, 3, "ready")
  const second = conversations(machine.account, file)
  await second.router.start()
  assert.equal(second.router.summaries()[0]?.session.id, conversationId)
  await until("the missed batch", () => second.events.length === 1)
  assert.equal(JSON.parse(second.events[0]!.payload).batch.revision, 3, "only what it hadn't relayed")
  await until("the summary caught up", () => second.router.summaries()[0]?.session.status === "ready")
})

/** Starts a cloud conversation over sockets and relays its first batch: a Mac in the middle of a cloud turn. */
async function midTurn(reach: Reach, name: string) {
  const machine = await cloudMachine(reach)
  const { router, events } = conversations(machine.account, join(scratch, name, "conversations.json"))
  const conversationId = randomUUID()
  await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId, cloud: { repository: REPOSITORY } }])
  const [threadId] = machine.created
  machine.batch(threadId!, conversationId, 2, "running")
  await until("the first batch", () => events.length === 1)
  const revisions = () => events.map((event) => z.object({ batch: z.object({ revision: z.number() }) }).parse(JSON.parse(event.payload)).batch.revision)
  return { machine, router, events, conversationId, threadId: threadId!, revisions }
}

const MISSED = 400

test("a Mac woken on a network the sleep didn't keep follows on at once: every event the machine sent meanwhile, once and in order", async () => {
  // A heartbeat as the app's: on its own it would find the dead socket only after a minute.
  const { machine, router, events, conversationId, threadId, revisions } = await midTurn({ sockets: { heartbeatMs: 25_000, wakeProbeMs: 500 } }, "slept")
  machine.network!.sleep()
  for (let revision = 3; revision < 3 + MISSED; revision++) machine.batch(threadId, conversationId, revision, revision % 2 ? "running" : "ready")
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(events.length, 1, "nothing arrives on the dead socket")
  const woke = performance.now()
  router.wake()
  await until("every missed event", () => events.length === 1 + MISSED, 5_000)
  const ms = performance.now() - woke
  assert.deepEqual(revisions(), Array.from({ length: 1 + MISSED }, (_, index) => index + 2), "each event once, in order")
  console.log(`  woke to ${MISSED} missed events relayed: ${ms.toFixed(0)} ms`)
  assert.ok(ms < 2_000, `caught up in ${ms.toFixed(0)} ms, the wake's probe (500 ms) included`)
  // Following on: the next event comes on the new connection.
  machine.batch(threadId, conversationId, 3 + MISSED, "ready")
  await until("the next event", () => events.length === 2 + MISSED)
  await until("the summary", () => router.summaries()[0]?.revision === 3 + MISSED)
})

test("without a wake to say so, the heartbeat finds the dead socket and the Mac follows on", async () => {
  const { machine, events, conversationId, threadId, revisions } = await midTurn({ sockets: { heartbeatMs: 100, silentMs: 300 } }, "silent")
  machine.network!.sleep()
  const slept = performance.now()
  for (let revision = 3; revision < 13; revision++) machine.batch(threadId, conversationId, revision, "running")
  await until("the missed events", () => events.length === 11, 5_000)
  console.log(`  dead socket found and followed on by the heartbeat alone: ${(performance.now() - slept).toFixed(0)} ms (silence allowed: 300 ms)`)
  assert.deepEqual(revisions(), Array.from({ length: 11 }, (_, index) => index + 2))
})

test("a wake while the connection is healthy keeps it: nothing is followed twice", async () => {
  const { machine, router, events, conversationId, threadId, revisions } = await midTurn({ sockets: { heartbeatMs: 25_000, wakeProbeMs: 300 } }, "awake")
  const open = machine.network!.open()
  router.wake()
  await new Promise((resolve) => setTimeout(resolve, 500))
  machine.batch(threadId, conversationId, 3, "ready")
  await until("the next event", () => events.length === 2)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(revisions(), [2, 3])
  assert.equal(machine.network!.open(), open, "no new connection")
})

test("a repository the cloud wouldn't take is refused before anything is made", async () => {
  const machine = await cloudMachine()
  const { router } = conversations(machine.account, join(scratch, "refused", "conversations.json"))
  await assert.rejects(router.route("mako:live-start", ["claude", "/x", { conversationId: randomUUID(), cloud: { repository: { url: "https://gitlab.com/a/b" } } }]))
  assert.equal(machine.created.length, 0)
})

test("a start that names no repository works in the folder's origin, on its upstream branch", async () => {
  const machine = await cloudMachine()
  const { router } = conversations(machine.account, join(scratch, "folder", "conversations.json"))
  await router.route("mako:live-start", ["grok", "/Users/me/project", { conversationId: randomUUID(), cloud: {} }])
  assert.equal(machine.created.length, 1)

  const git = new Git()
  const folder = join(scratch, "folder", "project")
  await mkdir(folder, { recursive: true })
  const output = (args: string[]) => git.output(folder, args)
  await output(["init", "--quiet", "--initial-branch", "main"])
  await assert.rejects(folderRepository(git, folder), /GitHub repository/)
  await output(["remote", "add", "origin", "git@github.com:octocat/Hello-World.git"])
  assert.deepEqual(await folderRepository(git, folder), REPOSITORY, "no upstream: the repository's default branch")
  await output(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "one"])
  await output(["update-ref", "refs/remotes/origin/feature", "HEAD"])
  await output(["branch", "--quiet", "--set-upstream-to", "origin/feature"])
  assert.deepEqual(await folderRepository(git, folder), { ...REPOSITORY, branch: "feature" })
})

test("a Git remote names its GitHub repository as the cloud takes it", () => {
  assert.equal(githubRepositoryUrl("git@github.com:Verbiflow/mako.git"), "https://github.com/Verbiflow/mako")
  assert.equal(githubRepositoryUrl("https://github.com/octocat/Hello-World.git"), "https://github.com/octocat/Hello-World")
  assert.equal(githubRepositoryUrl("ssh://git@github.com/octocat/Hello-World"), "https://github.com/octocat/Hello-World")
  assert.equal(githubRepositoryUrl("https://user@github.com/octocat/Hello-World/"), "https://github.com/octocat/Hello-World")
  assert.equal(githubRepositoryUrl("git@gitlab.com:a/b.git"), undefined)
})

test("a cloud conversation's folder is read on its machine, by its conversation: two Threads of one repository each read their own, and a burst of work tells a window once", async () => {
  const machine = await cloudMachine()
  const targets: string[] = []
  const session = machine.account.session
  machine.account.session = () => {
    const opened = session()
    return { ...opened, call: (operation) => (targets.push(`${operation.op} ${JSON.stringify(operation.target)}`), opened.call(operation)) }
  }
  const { router, changed } = conversations(machine.account, join(scratch, "folders", "conversations.json"))
  const [first, second] = [randomUUID(), randomUUID()]
  for (const conversationId of [first, second]) {
    const started = await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId, cloud: { repository: REPOSITORY } }])
    assert.ok(started.handled)
    assert.equal(z.object({ elsewhere: z.string() }).loose().parse(decodeRuntimeValue(started.value)).elsewhere, "a cloud machine", "the window hears from the start that its folder is on the machine")
  }
  const [firstThread, secondThread] = machine.created
  assert.ok(firstThread && secondThread && firstThread !== secondThread)
  assert.deepEqual(router.summaries().map((summary) => [summary.session.cwd, summary.elsewhere]), [[CLONE, "a cloud machine"], [CLONE, "a cloud machine"]], "one path on both machines")

  assert.equal(await router.folder("not-a-cloud-one"), undefined)
  for (const [conversationId, threadId] of [[first, firstThread], [second, secondThread]] as const) {
    const folder = await router.folder(conversationId)
    assert.equal(folder?.where, "a cloud machine")
    targets.length = 0
    const status = await folder!.call("mako:git-status", [])
    assert.ok(status !== "here")
    assert.deepEqual(decodeRuntimeValue(status.value), { channel: "mako:git-status" }, "the machine's host answered")
    assert.equal(targets.length, 1)
    assert.match(targets[0]!, new RegExp(`^host\\.git-status .*${threadId}`), "the call went to this conversation's Thread")
  }
  assert.ok(machine.calls.some((call) => call.channel === "mako:git-status"))

  // A burst of the agent's work on the first: the window reads its folder again once, a moment after.
  for (let revision = 2; revision <= 6; revision++) machine.batch(firstThread, first, revision, "running")
  await until("the first's change told", () => changed.length === 1, 3_000)
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  assert.deepEqual(changed, [first], "five batches, one change, and none for the other conversation")
})

test("a cloud app's view is asked passively at this Mac's preview of its port; asleep, it's said from what this Mac kept, the same after a restart, and a call waking the machine is told as it wakes", async () => {
  const machine = await cloudMachine()
  machine.app.view = { kind: "ready", project: "Hello-World", phase: "running", startedAt: 5, address: { host: "t.thread.localhost", port: 20000 }, processes: [{ name: "web", state: "running", port: 20000, memoryBytes: 1024 }], checks: [] }
  const passive: boolean[] = []
  const session = machine.account.session
  machine.account.session = () => {
    const opened = session()
    return { ...opened, call: (operation) => (operation.op === "host.thread-app" && passive.push(operation.passive === true), opened.call(operation)) }
  }
  const warned: string[] = []
  const stopHearing = followHostLog((line) => line.level !== "info" && warned.push(`${line.scope} ${line.message}`))
  after(stopHearing)
  const file = join(scratch, "app-view", "conversations.json")
  const { router, events } = conversations(machine.account, file)
  const machineEvents = () => events.filter((event) => event.type === "cloud-machine").map((event) => decodeRuntimeEvent<Extract<HostEvent, { type: "cloud-machine" }>>(event.payload))
  const conversationId = randomUUID()
  await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId, cloud: { repository: REPOSITORY } }])
  const folder = (await router.folder(conversationId))!
  const look = async (from = folder) => {
    const answered = await from.call("mako:thread-app", [CLONE])
    assert.ok(answered !== "here")
    // SAFETY: a look's answer is the view the machine's host or this Mac's router made, passed through as encoded.
    return decodeRuntimeValue(answered.value) as ThreadAppView
  }
  const view = await look()
  assert.ok(view.kind === "ready" && view.address)
  assert.equal(view.address.host, `${machine.created[0]}.cloud.localhost`, "the app at this Mac's preview of its port")
  assert.notEqual(view.address.port, 20000)
  assert.deepEqual(passive, [true], "a window's look, never a person's call")
  assert.deepEqual(machineEvents(), [], "an awake machine is never told of: nothing changed")

  // The machine goes to sleep: the look says so at once, from what this Mac kept, and wakes nothing.
  await machine.served.close()
  const started = performance.now()
  const asleep = await look()
  assert.ok(performance.now() - started < 1_000, "answered at once, never waited out")
  const expected: ThreadAppView = {
    kind: "asleep",
    project: "Hello-World",
    where: "a cloud machine",
    last: { phase: "running", startedAt: 5, address: view.address, processes: [{ name: "web", state: "running", port: 20000 }] },
  }
  assert.deepEqual(asleep, expected, "its processes as they paused, without the memory a pause holds still, at the same preview")
  assert.deepEqual(passive, [true, true])
  assert.deepEqual(machineEvents().map((event) => [event.machine, event.conversations]), [["asleep", [conversationId]]], "windows hear it fell asleep once")
  await look()
  assert.equal(machineEvents().length, 1, "a look finding it still asleep says nothing new")
  assert.equal(warned.length, 0, `a look the cloud passed over as designed is no warning: ${warned.join("; ")}`)

  // A host that restarts meanwhile knows nothing in memory, and says the same from what was kept with the conversation.
  await until("the kept app written", () => existsSync(file) && readFileSync(file, "utf8").includes('"app"'))
  const restarted = conversations(machine.account, file)
  const again = (await restarted.router.folder(conversationId))!
  // Each host serves its own preview of the port, at a port of its own.
  const afterRestart = await look(again)
  assert.ok(afterRestart.kind === "asleep" && afterRestart.last?.address)
  assert.deepEqual(afterRestart, { ...expected, last: { ...expected.last, address: { host: view.address.host, port: afterRestart.last.address.port } } }, "live and after a restart, the same")

  // A call that needs the machine wakes it: windows hear it's waking, the look says so, and once it answered, it's awake.
  const reading = folder.call("mako:git-status", [])
  await until("waking told", () => machineEvents().at(-1)?.machine === "waking")
  assert.deepEqual(await look(), { ...expected, waking: true })
  await machine.wake()
  await reading
  await until("awake told", () => machineEvents().at(-1)?.machine === "awake")
  assert.deepEqual(machineEvents().map((event) => event.machine), ["asleep", "waking", "awake"])
  const awake = await look()
  assert.equal(awake.kind, "ready")
  // The stand-in gateway refuses what the cloud's would hold for the wake: a person's call refused is still a warning.
  assert.ok(warned.includes("gateway-client operation failed"), "only a passive look's refusal is quiet")
})

test("a cloud machine woken by something this Mac didn't ask (another device, its own work) is heard awake from its Thread's events", async () => {
  const machine = await cloudMachine()
  const { router, events } = conversations(machine.account, join(scratch, "app-woken", "conversations.json"))
  const conversationId = randomUUID()
  await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId, cloud: { repository: REPOSITORY } }])
  const folder = (await router.folder(conversationId))!
  const threadId = machine.created[0]!
  await machine.served.close()
  const answered = await folder.call("mako:thread-app", [CLONE])
  assert.ok(answered !== "here")
  assert.equal(z.object({ kind: z.string() }).loose().parse(decodeRuntimeValue(answered.value)).kind, "asleep", "never seen awake here: asleep, with nothing kept")
  const told = () => events.filter((event) => event.type === "cloud-machine").map((event) => decodeRuntimeEvent<Extract<HostEvent, { type: "cloud-machine" }>>(event.payload).machine)
  assert.deepEqual(told(), ["asleep"])
  await machine.wake()
  machine.batch(threadId, conversationId, 2, "running")
  await until("awake told from its events", () => told().at(-1) === "awake")
})

test("in a Thread that moved to the cloud, a new tab and a fork start on its machine under the same Session IDs in both stores, so the way back carries them", async () => {
  const machine = await cloudMachine()
  const folder = join(scratch, "moved")
  await mkdir(folder, { recursive: true })
  let clock = 1_000
  const store = new ThreadStore(join(folder, "threads.sqlite"), { now: () => clock++, realPath: (path) => path })
  after(() => store.close())
  // A Thread of this Mac's, moved to a cloud Thread as `CloudMoves` leaves it: released here, the cloud's, followed.
  const moved = randomUUID()
  const placed = store.registerJournal({ conversationId: moved, createdAt: clock++, harness: "codex", bindings: [{ provider: "codex", nativeId: "n-0", path: "/codex/n-0.jsonl" }] }, store.person())
  const cloudThread = "t-00000000000000aa"
  await machine.account.createThread(cloudThread, REPOSITORY)
  const runtime = cloudRuntimeOf(cloudThread)
  const move = MoveIdSchema.parse(randomUUID())
  store.beginMove({ move, thread: placed.thread, target: { kind: "cloud", runtime }, actor: store.person() })
  const handoff = store.release({ operationId: randomUUID(), move, actor: store.person() })
  store.confirm({ operationId: randomUUID(), receipt: { move, owner: { kind: "cloud", runtime }, sessions: handoff.sessions.map((session) => ({ id: session.id, generation: session.generation + 1 })) }, actor: store.person() })
  let returning: Promise<void> | undefined
  const router = new CloudConversations({ account: () => machine.account, file: join(folder, "conversations.json"), emit: () => {}, repositoryOf: async () => REPOSITORY, threads: () => store, returning: () => returning })
  after(() => router.dispose())
  await router.adopt({ conversationId: moved, threadId: cloudThread, harness: "codex", repository: REPOSITORY })
  router.started(moved, encodeRuntimeValue({ session: { id: moved, harness: "codex", cwd: CLONE, status: "ready", nativeId: "n-0" }, revision: 1, createdAt: 1 }))

  // A `+` tab: the Session the window made here is the cloud's, as its Thread is; its first send starts on the machine.
  const tab = store.createSession({ operationId: randomUUID(), thread: placed.thread, actor: store.person() })
  const execution = store.execution(tab.session)
  assert.deepEqual(execution?.state === "elsewhere" && execution.owner, { kind: "cloud", runtime })
  const conversation = randomUUID()
  const options = { conversationId: conversation, session: tab.session, worktree: true, threadPath: "/Users/me/x.jsonl", initialRequest: { id: "r-1", text: "hi", attachments: [] } }
  const started = await router.route("mako:live-start", ["claude", "/Users/me/project", options])
  assert.ok(started.handled, "a start in a Session of the cloud's goes to its machine")
  assert.equal(z.object({ elsewhere: z.string() }).loose().parse(decodeRuntimeValue(started.value)).elsewhere, "a cloud machine")
  const made = machine.calls.find((call) => call.channel === "mako:thread-create-session")
  assert.deepEqual(made?.args.slice(1), [placed.thread, tab.session], "the machine's store takes the tab's Session under the same ID")
  const start = machine.calls.findLast((call) => call.channel === "mako:live-start")
  assert.equal(start?.args[1], CLONE, "in the Thread's checkout there")
  const sent = z.object({ session: z.string() }).loose().parse(start?.args[2])
  assert.equal(sent.session, tab.session)
  for (const key of ["worktree", "threadPath", "cloud"]) assert.equal(key in sent, false, `${key} stays on this Mac`)
  assert.deepEqual(store.journalPlacement(conversation), { thread: placed.thread, session: tab.session }, "recorded here in its tab's Session")
  assert.ok(router.has(conversation))
  await router.route("mako:live-start", ["claude", "/Users/me/project", options])
  assert.deepEqual(store.journalPlacement(conversation), { thread: placed.thread, session: tab.session }, "a repeated start changes nothing")
  assert.equal(router.threadConversations(cloudThread).length, 2)

  // A fork: made on the machine, recorded here in the Session the machine's store gave it, beside its parent's.
  const forkId = randomUUID()
  const point = { kind: "run", requestId: randomUUID() }
  const forked = await router.route("mako:live-fork", [moved, { id: forkId, provider: "codex", point }])
  assert.ok(forked.handled)
  const forkSession = machine.forkSessions.get(forkId)
  assert.equal(forkSession, namedUuid(`mako cloud fork session\0${forkId}`), "the fork goes into a Session this Mac named, from the fork's ID")
  assert.deepEqual(store.journalPlacement(forkId), { thread: placed.thread, session: forkSession }, "the same Session ID in both stores")
  assert.equal(store.execution(SessionIdSchema.parse(forkSession))?.state, "elsewhere")
  assert.ok(router.has(forkId), "followed with the Thread's other conversations")
  // A machine on an older image names the Session itself: one of its own is filed as it says, and one the Thread already
  // has (its parent tab's, as was seen) is filed the same here, so the two stores agree and it comes back with the Thread.
  machine.filing.older = true
  const ownSession = randomUUID()
  assert.ok((await router.route("mako:live-fork", [moved, { id: ownSession, provider: "codex", point }])).handled)
  assert.deepEqual(store.journalPlacement(ownSession), { thread: placed.thread, session: machine.forkSessions.get(ownSession) }, "an older machine's own Session is filed as it says")
  machine.filing.into = tab.session
  const intoParent = randomUUID()
  assert.ok((await router.route("mako:live-fork", [conversation, { id: intoParent, provider: "claude", point }])).handled)
  assert.deepEqual(store.journalPlacement(intoParent), { thread: placed.thread, session: tab.session }, "in the Session the machine gave it")
  assert.ok(router.has(intoParent), "followed with the Thread's other conversations")
  machine.filing.into = undefined
  machine.filing.older = false
  await assert.rejects(router.route("mako:live-fork", [moved, { id: randomUUID(), provider: "codex", point, thread: "new" }]), /forks within its Thread there/)
  await assert.rejects(router.route("mako:live-fork", [moved, { id: randomUUID(), provider: "codex", point, worktree: true }]), /works in its machine's checkout/)

  // On its way back nothing runs the Thread, so it begins nothing more there: a start in it and a fork wait for the
  // return, then go where it runs after, here once it's back, never to the machine that gave it up.
  let back = () => {}
  returning = new Promise<void>((resolve) => (back = resolve))
  const late = store.createSession({ operationId: randomUUID(), thread: placed.thread, actor: store.person() })
  const sentBefore = machine.calls.length
  const lateStart = router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId: randomUUID(), session: late.session }])
  const lateFork = router.route("mako:live-fork", [moved, { id: randomUUID(), provider: "codex", point }])

  // A Session that runs here is this Mac's to start, whatever else is coming back.
  const local = store.registerJournal({ conversationId: randomUUID(), createdAt: clock++, harness: "codex", bindings: [] }, store.person())
  assert.equal((await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId: randomUUID(), session: local.session }])).handled, false)
  // Back, as `CloudReturns` brings it: this Mac's store claims it, each conversation is answered here again, and the return is over.
  claimBack(store, placed.thread, runtime, clock++)
  assert.deepEqual(await router.releaseThread(cloudThread), [moved, conversation, forkId, ownSession, intoParent], "coming back, each is answered here again")
  returning = undefined
  back()
  assert.deepEqual([(await lateStart).handled, (await lateFork).handled], [false, false], "both answered here, where the Thread runs now")
  assert.equal(machine.calls.length, sentBefore, "nothing went to the machine on the way back")
  assert.equal(router.has(conversation), false)

  // A store takes a Session under the ID its Thread's other place gave it (as the machine's does), once.
  const given = SessionIdSchema.parse(randomUUID())
  const operationId = randomUUID()
  assert.equal(store.createSession({ operationId, thread: placed.thread, actor: store.person(), session: given }).session, given)
  assert.equal(store.createSession({ operationId, thread: placed.thread, actor: store.person(), session: given }).session, given, "asked again, the same")
  assert.throws(() => store.createSession({ operationId: randomUUID(), thread: placed.thread, actor: store.person(), session: given }), /exists here already/)
})

test("every Session the account lists is listed here, unopened and waking nothing: another device's cloud conversations and its own; each changes and leaves as the list does, and opened it's answered and followed where it runs", async () => {
  const machine = await cloudMachine()
  const theirs = "t-00000000000000aa"
  await machine.account.createThread(theirs, REPOSITORY)
  const myDevice = await machine.account.deviceId()
  const studio = "9c1f4a2e-5b6d-4e8f-a1b2-c3d4e5f60718"
  // The Studio's own runtime, as the cloud reaches it: its calls answered there, its conversations streamed while watched.
  const studioCalls: string[] = []
  const captures: unknown[][] = []
  const watched: string[][] = []
  const studioRuntime = await serveHostThroughGateway(await machine.gateway.connectRuntime(), {
    runtimeId: `d-${studio}`,
    build: "test",
    invoke: async (channel, args) => {
      studioCalls.push(channel)
      if (channel === "mako:live-capture") {
        captures.push([...args])
        // A capture takes the Studio a moment: a second open meanwhile waits for it.
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return JSON.stringify({ channel })
    },
    watch: (conversations) => watched.push([...conversations]),
  })
  after(() => studioRuntime.close())
  const cloudConversation = randomUUID()
  const studioConversation = randomUUID()
  const row = (conversation: string, runsOn: ListedSession["runsOn"], state: ListedState, extra: Partial<ListedSession> = {}): ListedSession => ({
    session: randomUUIDFor(conversation),
    thread: "6f1c9a52-0d4e-4b8e-9a51-3f2c7d1e8b40",
    conversation,
    harness: "claude",
    title: "Retry the webhooks",
    state,
    folder: CLONE,
    createdAt: "2026-10-24T20:00:00.000Z",
    activityAt: "2026-10-24T20:00:00.000Z",
    generation: 1,
    runsOn,
    listedAt: "2026-10-24T20:00:01.000Z",
    ...extra,
  })
  const inCloud = (state: ListedState, extra: Partial<ListedSession> = {}) => row(cloudConversation, { kind: "cloud", threadId: theirs }, state, extra)
  const onStudio = (state: ListedState, extra: Partial<ListedSession> = {}) => row(studioConversation, { kind: "device", deviceId: studio }, state, extra)
  const mine = row(randomUUID(), { kind: "device", deviceId: myDevice! }, "working")
  const listeners = new Set<(heard: AccountListHeard | "account-changed") => void>()
  let answer: SessionListings = { sessions: [inCloud("working"), onStudio("waiting", { waitingOn: "Approve: npm test" }), mine], seq: 5 }
  let reads = 0
  machine.account.sessionListings = async () => (reads++, answer)
  machine.account.devices = async () => ({ devices: [{ id: studio, name: "Studio" }], current: myDevice! })
  machine.account.onThreadListings = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const say = (heard: AccountListHeard | "account-changed") => {
    for (const listener of listeners) listener(heard)
  }
  const file = join(scratch, "listed", "conversations.json")
  const { router, events, archived } = conversations(machine.account, file)
  await router.start()
  const shown = (id: string) => router.summaries().find((summary) => summary.session.id === id)
  await until("the list read and listed here", () => shown(cloudConversation) !== undefined && shown(studioConversation) !== undefined)
  // Which cloud Thread a row's archive is the cloud's to keep, and which the Studio's: never this Mac's.
  assert.equal(await router.cloudThreadOf({ conversationId: cloudConversation }), theirs)
  assert.equal(await router.cloudThreadOf({ sessionId: inCloud("idle").session }), theirs, "by its Session too")
  assert.equal(await router.cloudThreadOf({ conversationId: studioConversation }), undefined)
  assert.equal(await router.archiveOnOwner(cloudConversation, { id: randomUUID(), archived: true }), false, "a cloud Thread's archive isn't a device's")
  assert.equal(await router.archiveOnOwner(studioConversation, { id: randomUUID(), archived: true }), true)
  assert.deepEqual(studioCalls, ["mako:thread-archive"], "the Studio's Session is archived by the Studio, its owner")
  studioCalls.length = 0
  assert.equal(shown(mine.conversation), undefined, "this Mac's own Sessions are its own")
  assert.deepEqual([shown(cloudConversation)?.session.status, shown(cloudConversation)?.elsewhere], ["running", "a cloud machine"])
  assert.deepEqual([shown(studioConversation)?.elsewhere, shown(studioConversation)?.waitingOn], ["Studio", "Approve: npm test"], "where it runs, by name, and what it waits on")
  assert.equal(shown(studioConversation)?.sessionId, onStudio("idle").session, "filed under its own Session")
  const told = (type: string) => events.filter((event) => event.type === type).map((event) => JSON.parse(event.payload))
  assert.equal(told("live-listed").length, 1, "windows list them as they list one at boot")
  assert.deepEqual([machine.calls.length, studioCalls.length], [0, 0], "listing them called nothing anywhere")

  say({ seq: 5, event: { type: "sessions-listed", sessions: [inCloud("idle")] } })
  assert.equal(shown(cloudConversation)?.session.status, "running", "a change from before the list read changes nothing")
  say({ seq: 6, event: { type: "sessions-listed", sessions: [onStudio("idle", { title: "Retry the webhooks with backoff" })] } })
  assert.deepEqual([shown(studioConversation)?.session.status, shown(studioConversation)?.waitingOn, shown(studioConversation)?.session.title], ["ready", undefined, "Retry the webhooks with backoff"])
  const before = told("live-listed").length
  say({ seq: 7, event: { type: "sessions-listed", sessions: [onStudio("idle", { title: "Retry the webhooks with backoff", listedAt: "2026-10-24T21:00:00.000Z" })] } })
  assert.equal(told("live-listed").length, before, "a change a row wouldn't show tells nobody")
  const remembered = await readFile(file, "utf8").catch(() => "{\"conversations\":[]}")
  assert.equal(JSON.parse(remembered).conversations.length, 0, "listed ones aren't remembered; the list says them again")

  // Opened on the Studio: answered there, and its live updates arrive while it's watched, and stop after.
  const opened = await router.route("mako:live-snapshot", [studioConversation])
  assert.ok(opened.handled)
  assert.deepEqual(studioCalls, ["mako:live-snapshot"], "answered by the Studio, where it runs")
  await until("the Studio told it's watched", () => watched.at(-1)?.includes(studioConversation) === true)
  // SAFETY: a batch as the Studio's live driver sends it, filled only as far as the router and summary read it.
  studioRuntime.live(studioConversation, Payload.encoded(runtimeEventLine("event", encodeRuntimeEvent({ type: "live-batch", batch: { id: studioConversation, revision: 3, updates: [] } } as never)).slice(0, -1)))
  await until("its batch relayed", () => events.some((event) => event.conversation === studioConversation))

  // A session the Studio's terminal runs, which Mako there hasn't opened: listed like the rest, opened there first.
  const terminalConversation = randomUUID()
  const terminalPath = "/Users/ana/.claude/projects/-Users-ana-api/0b7e.jsonl"
  const inTerminal = row(terminalConversation, { kind: "device", deviceId: studio }, "waiting", { waitingOn: "Approve: rm -rf dist", nativeId: "0b7e", capture: { path: terminalPath } })
  say({ seq: 8, event: { type: "sessions-listed", sessions: [inTerminal] } })
  await until("the terminal's session listed", () => shown(terminalConversation) !== undefined)
  assert.deepEqual([shown(terminalConversation)?.elsewhere, shown(terminalConversation)?.waitingOn], ["Studio", "Approve: rm -rf dist"])
  assert.equal(captures.length, 0, "listing it opens nothing on the Studio")
  studioCalls.length = 0
  const [first, second] = await Promise.all([router.route("mako:live-snapshot", [terminalConversation]), router.route("mako:live-read", [terminalConversation])])
  assert.ok(first.handled && second.handled)
  assert.deepEqual(captures, [[terminalConversation, terminalPath]], "opened on the Studio once, as the conversation the list named, by the path the Studio reads it at")
  assert.equal(studioCalls[0], "mako:live-capture", "before anything else is asked of it")
  await router.route("mako:live-snapshot", [terminalConversation])
  assert.equal(captures.length, 1, "and not again")

  // Opened in the cloud: answered on its machine, followed from the stream's head.
  machine.batch(theirs, cloudConversation, 1, "running")
  assert.ok((await router.route("mako:live-snapshot", [cloudConversation])).handled)
  assert.ok(machine.calls.some((call) => call.channel === "mako:live-snapshot"))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(events.filter((event) => event.conversation === cloudConversation).length, 0, "the batch from before it was opened isn't replayed")
  machine.batch(theirs, cloudConversation, 2, "ready")
  await until("its next batch relayed", () => events.some((event) => event.conversation === cloudConversation))

  // The Thread is renamed on the Studio while a window here follows its conversation: the batches never carry the
  // Thread's name, so the list's word on it reaches the window, the rest of what it shows left as the batches said it.
  const followedBefore = shown(studioConversation)
  say({ seq: 9, event: { type: "sessions-listed", sessions: [onStudio("idle", { title: "Retry the webhooks with backoff", threadTitle: "Webhook retries" })] } })
  assert.equal(shown(studioConversation)?.threadTitle, "Webhook retries", "a followed conversation's Thread is named as the list says")
  assert.deepEqual(told("live-listed").at(-1)?.summaries.map((summary: { session: { id: string }; threadTitle?: string }) => [summary.session.id, summary.threadTitle]), [[studioConversation, "Webhook retries"]], "and windows are told")
  assert.deepEqual(shown(studioConversation)?.session, followedBefore?.session, "what its batches said stands")

  // The Studio's Session moved to the cloud: it leaves the Studio, and is listed where it runs now.
  say({ seq: 10, event: { type: "sessions-listed", sessions: [row(studioConversation, { kind: "cloud", threadId: theirs }, "idle", { generation: 3, session: onStudio("idle").session })] } })
  assert.equal(told("live-unlisted").length, 0, "a move is never told as leaving")
  assert.equal(shown(studioConversation)?.elsewhere, "a cloud machine", "it's listed where it runs now")
  assert.equal(told("live-listed").at(-1)?.summaries[0]?.elsewhere, "a cloud machine")
  await until("the Studio no longer watched for it", () => watched.at(-1)?.includes(studioConversation) === false)
  assert.deepEqual(watched.at(-1), [terminalConversation], "the terminal's, opened, still is")

  // Archived by its person on another device: its Sessions leave the list, and it's kept with the archived ones, at rest,
  // still named by its cloud Thread, and the host is told so (what every window shows as archived).
  say({ seq: 11, event: { type: "sessions-unlisted", sessions: [inCloud("idle").session] } })
  say({ seq: 12, event: { type: "thread-archived", thread: { thread: theirs, move: randomUUID(), archivedAt: "2026-10-27T10:00:00.000Z", sessions: [inCloud("working")] } } })
  await until("the host told it's archived", () => archived.at(-1)?.includes(theirs) === true)
  assert.deepEqual([shown(cloudConversation)?.session.status, shown(cloudConversation)?.elsewhere], ["ready", "a cloud machine"], "with the archived ones, at rest")
  assert.equal(await router.cloudThreadOf({ conversationId: cloudConversation }), theirs, "restoring it finds its cloud Thread")
  assert.equal(router.archiveOf(theirs)?.thread, theirs)
  say({ seq: 13, event: { type: "thread-unarchived", thread: theirs } })
  await until("the host told it's back", () => archived.at(-1)?.includes(theirs) === false)
  assert.equal(shown(cloudConversation), undefined, "taken back by its Mac, which lists it as its own")
  assert.equal((await router.route("mako:live-snapshot", [cloudConversation])).handled, false, "no longer answered here")

  // Another account: whatever the last one listed is gone, and the new account's list is read.
  answer = { sessions: [inCloud("idle")], seq: 1 }
  const reading = reads
  say("account-changed")
  await until("the new account's list read", () => reads > reading && shown(cloudConversation) !== undefined && shown(studioConversation) === undefined)
})

test("a second Mako on this Mac, which lists this Mac's own sessions as its own, adds no rows here; another device's rows say its name once it's heard of, and their Thread's name", async () => {
  const machine = await cloudMachine()
  const myDevice = await machine.account.deviceId()
  // Another profile on this Mac, reading the same harness stores, and the Studio, a Mac enrolled after the list was read.
  const profile = "2d7c5e10-4f3a-4b6e-9c8d-1a2b3c4d5e6f"
  const studio = "8e4b1f20-6a7c-4d9e-b0f1-2c3d4e5f6a7b"
  const folder = "/Users/ana/api"
  const row = (runsOn: ListedSession["runsOn"], extra: Partial<ListedSession> = {}): ListedSession => ({
    session: randomUUID(), thread: randomUUID(), conversation: randomUUID(), harness: "claude", title: "Retry the webhooks", state: "idle", folder,
    createdAt: "2026-10-27T07:20:00.000Z", activityAt: "2026-10-27T07:20:00.000Z", generation: 1, runsOn, listedAt: "2026-10-27T07:20:01.000Z", ...extra,
  })
  // The profile's catalog found a terminal's session in the stores this Mac reads too, and a conversation it opened
  // wrote its session there as well: this Mac keeps both, in the same folder, under Sessions of its own.
  const terminal = row({ kind: "device", deviceId: profile }, { nativeId: "0b7e", capture: { path: "/Users/ana/.claude/projects/-Users-ana-api/0b7e.jsonl" } })
  const opened = row({ kind: "device", deviceId: profile }, { harness: "cursor", nativeId: "4c1d" })
  // A session of the same harness and ID in another folder is another computer's own.
  const same = row({ kind: "device", deviceId: profile }, { nativeId: "0b7e", folder: "/Users/bo/api" })
  // The Studio's Thread, two Sessions under the name it was given there.
  const studioThread = randomUUID()
  const onStudio = [row({ kind: "device", deviceId: studio }, { thread: studioThread, threadTitle: "Webhook retries", nativeId: "9f2a" }), row({ kind: "device", deviceId: studio }, { thread: studioThread, threadTitle: "Webhook retries", harness: "codex" })]
  // A Session that moved to a cloud machine runs there, whatever copy of its session is left on this Mac.
  const inCloud = row({ kind: "cloud", threadId: "t-00000000000000ab" }, { nativeId: "0b7e" })
  const kept = new Set([`claude\n0b7e\n${folder}`, `cursor\n4c1d\n${folder}`])
  machine.account.sessionListings = async () => ({ sessions: [terminal, opened, same, ...onStudio, inCloud], seq: 1 })
  let deviceReads = 0
  machine.account.devices = async () => ({ devices: [{ id: profile, name: "Ana's MacBook Pro (2)" }, ...(deviceReads++ ? [{ id: studio, name: "Studio" }] : [])], current: myDevice! })
  machine.account.onThreadListings = () => () => {}
  const events: RuntimeEvent[] = []
  const router = new CloudConversations({
    account: () => machine.account, file: join(await mkdtemp(join(tmpdir(), "mako-listed-here-")), "conversations.json"), emit: (event) => events.push(event), repositoryOf: async () => REPOSITORY,
    keepsNative: (harness, nativeId, at) => kept.has(`${harness}\n${nativeId}\n${at}`),
    nativeChangedMs: 0,
  })
  after(() => router.dispose())
  await router.start()
  const shown = (id: string) => router.summaries().find((summary) => summary.session.id === id)
  await until("the list read and listed here", () => shown(inCloud.conversation) !== undefined)
  assert.equal(shown(terminal.conversation), undefined, "a session this Mac keeps is listed once, as this Mac's")
  assert.equal(shown(opened.conversation), undefined, "a conversation the other profile opened too")
  assert.equal(shown(same.conversation)?.elsewhere, "Ana's MacBook Pro (2)", "the same ID in another folder is that computer's own")
  assert.equal(shown(inCloud.conversation)?.elsewhere, "a cloud machine")
  await until("the Studio named, its devices read again", () => shown(onStudio[0]!.conversation)?.elsewhere === "Studio")
  assert.equal(deviceReads, 2, "read again once, for the device it hadn't heard of")
  assert.deepEqual(onStudio.map((each) => [shown(each.conversation)?.elsewhere, shown(each.conversation)?.threadId, shown(each.conversation)?.threadTitle]), [["Studio", studioThread, "Webhook retries"], ["Studio", studioThread, "Webhook retries"]], "both filed under the Studio's Thread, by its name")

  // The session leaves this Mac's stores (its harness deleted it here): the other profile's row is listed.
  kept.delete(`cursor\n4c1d\n${folder}`)
  router.nativeChanged()
  await until("looked at again", () => shown(opened.conversation)?.elsewhere === "Ana's MacBook Pro (2)")
  assert.equal(shown(terminal.conversation), undefined)
})

test("the account's rows for sessions this Mac may keep wait for its catalog, a lost catalog takes none away, and a burst of its writes is one look at the rows they name", async () => {
  const machine = await cloudMachine()
  const myDevice = await machine.account.deviceId()
  const profile = "2d7c5e10-4f3a-4b6e-9c8d-1a2b3c4d5e6f"
  const folder = "/Users/ana/api"
  const row = (runsOn: ListedSession["runsOn"], extra: Partial<ListedSession> = {}): ListedSession => ({
    session: randomUUID(), thread: randomUUID(), conversation: randomUUID(), harness: "claude", title: "Retry the webhooks", state: "idle", folder,
    createdAt: "2026-10-27T07:20:00.000Z", activityAt: "2026-10-27T07:20:00.000Z", generation: 1, runsOn, listedAt: "2026-10-27T07:20:01.000Z", ...extra,
  })
  // The other profile's rows: one for a session this Mac's stores keep, one for a session they don't; and a cloud row.
  const terminal = row({ kind: "device", deviceId: profile }, { nativeId: "0b7e" })
  const theirs = row({ kind: "device", deviceId: profile }, { nativeId: "9f2a" })
  const inCloud = row({ kind: "cloud", threadId: "t-00000000000000ad" })
  machine.account.sessionListings = async () => ({ sessions: [terminal, theirs, inCloud], seq: 1 })
  machine.account.devices = async () => ({ devices: [{ id: profile, name: "Ana's MacBook Pro (2)" }], current: myDevice! })
  machine.account.onThreadListings = () => () => {}
  // This Mac's catalog, not read yet: it can't say what the stores keep.
  let ready = false
  const kept = new Set([`claude\n0b7e\n${folder}`])
  let asked = 0
  const events: RuntimeEvent[] = []
  const router = new CloudConversations({
    account: () => machine.account, file: join(await mkdtemp(join(tmpdir(), "mako-keeps-")), "conversations.json"), emit: (event) => events.push(event), repositoryOf: async () => REPOSITORY,
    keepsNative: (harness, nativeId, at) => {
      asked += 1
      return ready ? kept.has(`${harness}\n${nativeId}\n${at}`) : undefined
    },
    nativeChangedMs: 20,
  })
  after(() => router.dispose())
  await router.start()
  const shown = (each: ListedSession) => router.summaries().find((summary) => summary.session.id === each.conversation)
  await until("the list read", () => shown(inCloud) !== undefined)
  assert.equal(shown(terminal), undefined, "a row this Mac may keep isn't listed while its catalog can't say")
  assert.equal(shown(theirs), undefined, "nor one it may not: it isn't listed and then taken away")

  ready = true
  router.nativeChanged()
  await until("the catalog read, the rows looked at", () => shown(theirs) !== undefined)
  assert.equal(shown(terminal), undefined, "the session this Mac keeps is listed once, as this Mac's")

  // A session at work writes over and over: a hundred writes are one look, at the rows that name its session alone.
  const listedBefore = events.filter((event) => event.type === "live-listed").length
  asked = 0
  for (let write = 0; write < 100; write++) router.nativeChanged([{ harness: "codex", nativeId: "a-session-no-row-names" }])
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(asked, 0, "no row names it: nothing is looked at")
  kept.delete(`claude\n0b7e\n${folder}`)
  for (let write = 0; write < 100; write++) router.nativeChanged([{ harness: "claude", nativeId: "0b7e" }])
  await until("the session left this Mac's stores: the other profile's row is listed", () => shown(terminal) !== undefined)
  assert.equal(asked, 1, "one look, at the one row that names it")
  assert.equal(events.filter((event) => event.type === "live-listed").length, listedBefore + 1)

  // The catalog's reader is lost and read again: until it's back, the rows stay as they are.
  ready = false
  router.nativeChanged()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.ok(shown(terminal) && shown(theirs), "a catalog being read again says nothing of what the stores keep")
  assert.equal(events.filter((event) => event.type === "live-unlisted").length, 0, "nothing unlisted")
})

test("an account event is looked at for the rows it names alone: one Session's change among many asks of that row only, a Session that left goes, and a device going quiet looks at every row", async () => {
  const machine = await cloudMachine()
  const myDevice = await machine.account.deviceId()
  const studio = "8e4b1f20-6a7c-4d9e-b0f1-2c3d4e5f6a7b"
  const row = (n: number, extra: Partial<ListedSession> = {}): ListedSession => ({
    session: randomUUID(), thread: randomUUID(), conversation: randomUUID(), harness: "claude", title: `Session ${n}`, state: "idle", folder: "/Users/ana/api", nativeId: `n-${n}`,
    createdAt: "2026-10-27T07:20:00.000Z", activityAt: "2026-10-27T07:20:00.000Z", generation: 1, runsOn: { kind: "device", deviceId: studio }, listedAt: "2026-10-27T07:20:01.000Z", ...extra,
  })
  const rows = Array.from({ length: 20 }, (_, n) => row(n))
  machine.account.sessionListings = async () => ({ sessions: rows, seq: 1 })
  machine.account.devices = async () => ({ devices: [{ id: studio, name: "Studio" }], current: myDevice! })
  let say: ((heard: AccountListHeard | "account-changed") => void) | undefined
  machine.account.onThreadListings = (listener) => {
    say = listener
    return () => {}
  }
  // Each row of another device is asked whether this Mac keeps its session: what a look at a row costs.
  let asked = 0
  const router = new CloudConversations({
    account: () => machine.account, file: join(await mkdtemp(join(tmpdir(), "mako-named-")), "conversations.json"), emit: () => {}, repositoryOf: async () => REPOSITORY,
    keepsNative: () => (asked++, false),
    nativeChangedMs: 0,
  })
  after(() => router.dispose())
  await router.start()
  const shown = (each: ListedSession) => router.summaries().find((summary) => summary.session.id === each.conversation)
  await until("the list read and listed here", () => rows.every((each) => shown(each) !== undefined))
  asked = 0
  say?.({ seq: 2, event: { type: "sessions-listed", sessions: [{ ...rows[3]!, state: "working" }] } })
  assert.equal(shown(rows[3]!)?.session.status, "running", "the change is listed at once")
  assert.equal(asked, 1, "one row named, one row looked at")
  say?.({ seq: 3, event: { type: "sessions-unlisted", sessions: [rows[5]!.session] } })
  assert.equal(shown(rows[5]!), undefined, "a Session that left the list goes")
  assert.equal(asked, 1, "and nothing else is looked at for it")
  say?.({ seq: 4, event: { type: "device-quiet", deviceId: studio, since: "2026-10-27T07:25:00.000Z" } })
  assert.equal(asked, 1 + rows.length - 1, "a device going quiet may change any of its rows: every one is looked at")
  assert.equal(shown(rows[3]!)?.session.status, "ready", "and none of a quiet device's is at work")
})

test("a quiet device's conversation a window has open stops working there too, and says it's back when it is", async () => {
  const machine = await cloudMachine()
  const myDevice = await machine.account.deviceId()
  const studio = "6a1f0c3e-2b4d-4e8f-9a7c-5d3e1b0f2c4a"
  const listed: ListedSession = {
    session: randomUUID(), thread: randomUUID(), conversation: randomUUID(), harness: "claude", title: "Retry the webhooks", state: "working", folder: "/Users/ana/api",
    createdAt: "2026-10-27T07:20:00.000Z", activityAt: "2026-10-27T07:20:00.000Z", generation: 1, runsOn: { kind: "device", deviceId: studio }, listedAt: "2026-10-27T07:20:01.000Z",
  }
  machine.account.sessionListings = async () => ({ sessions: [listed], seq: 1 })
  machine.account.devices = async () => ({ devices: [{ id: studio, name: "Studio" }], current: myDevice! })
  const listeners = new Set<(heard: AccountListHeard | "account-changed") => void>()
  machine.account.onThreadListings = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const say = (heard: AccountListHeard) => {
    for (const listener of listeners) listener(heard)
  }
  const studioRuntime = await serveHostThroughGateway(await machine.gateway.connectRuntime(), {
    runtimeId: `d-${studio}`,
    build: "test",
    invoke: async () => JSON.stringify({ session: { id: listed.conversation } }),
  })
  after(() => studioRuntime.close())
  const events: RuntimeEvent[] = []
  const router = new CloudConversations({ account: () => machine.account, file: join(await mkdtemp(join(tmpdir(), "mako-quiet-open-")), "conversations.json"), emit: (event) => events.push(event), repositoryOf: async () => REPOSITORY })
  after(() => router.dispose())
  await router.start()
  await until("listed", () => router.summaries().some((summary) => summary.session.id === listed.conversation))
  // A window opens it: from now its batches come here from its stream, and the list's rows for it aren't listed again.
  assert.ok((await router.route("mako:live-state", [listed.conversation])).handled)
  const told = () => events.flatMap((event) => event.type === "live-listed" ? decodeRuntimeEvent<Extract<HostEvent, { type: "live-listed" }>>(event.payload).summaries : [])
    .filter((summary) => summary.session.id === listed.conversation)
  const before = told().length
  // The Studio goes quiet mid-turn: it sends nothing more, so nothing but the list can say its turn isn't going on.
  const since = "2026-10-27T08:00:00.000Z"
  say({ seq: 2, event: { type: "device-quiet", deviceId: studio, since } })
  assert.equal(told().length, before + 1, "the window is told")
  assert.deepEqual([told().at(-1)?.session.status, told().at(-1)?.quietSince], ["ready", Date.parse(since)], "not at work, and since when it's been quiet")
  say({ seq: 3, event: { type: "device-quiet", deviceId: studio, since: null } })
  assert.equal(told().length, before + 2, "and told it's back, so it reads it there again")
  assert.equal(told().at(-1)?.quietSince, undefined)
  // Anything else the list says of it is the window's own batches' to say.
  say({ seq: 4, event: { type: "sessions-listed", sessions: [{ ...listed, state: "idle", listedAt: "2026-10-27T08:01:00.000Z" }] } })
  assert.equal(told().length, before + 2)
})

test("the account's archived cloud Threads are said only from a list it answered, never as none at a sign-out or before the list is read", async () => {
  const machine = await cloudMachine()
  const archivedThread = { thread: "t-00000000000000ae", move: randomUUID(), archivedAt: "2026-10-27T09:00:00.000Z", sessions: [] }
  let listings: SessionListings = { sessions: [], seq: 1, archived: [archivedThread] }
  machine.account.sessionListings = async () => listings
  machine.account.devices = async () => ({ devices: [], current: (await machine.account.deviceId())! })
  let tell: ((heard: AccountListHeard | "account-changed") => void) | undefined
  machine.account.onThreadListings = (listener) => ((tell = listener), () => {})
  const heard: [string, string[]][] = []
  const router = new CloudConversations({
    account: () => machine.account, file: join(await mkdtemp(join(tmpdir(), "mako-archived-")), "conversations.json"), emit: () => {}, repositoryOf: async () => REPOSITORY,
    archivedChanged: (account, archived) => heard.push([account, [...archived.keys()]]),
  })
  after(() => router.dispose())
  await router.start()
  const account = await machine.account.id()
  await until("the list read", () => heard.length > 0)
  assert.deepEqual(heard, [[account, [archivedThread.thread]]])
  // Signed out, or another account: the list is forgotten, but that says nothing of what's archived.
  listings = { sessions: [], seq: 1 }
  let answer: () => void = () => {}
  const answered = new Promise<void>((resolve) => (answer = resolve))
  machine.account.sessionListings = async () => (await answered, listings)
  tell?.("account-changed")
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(heard, [[account, [archivedThread.thread]]], "the archived Threads stand until a list says otherwise")
  answer()
  await until("the new list read", () => heard.length > 1)
  assert.deepEqual(heard.at(-1), [account, []], "a list read says it, even when it's the same as before but for what's archived")
})

test("a quiet device's rows are listed as it left them, but none at work or waiting on the person; heard from again, each says its state again", async () => {
  const machine = await cloudMachine()
  const myDevice = await machine.account.deviceId()
  const studio = "8e4b1f20-6a7c-4d9e-b0f1-2c3d4e5f6a7b"
  const row = (state: ListedState, extra: Partial<ListedSession> = {}): ListedSession => ({
    session: randomUUID(), thread: randomUUID(), conversation: randomUUID(), harness: "claude", title: "Retry the webhooks", state, folder: "/Users/ana/api",
    createdAt: "2026-10-27T07:20:00.000Z", activityAt: "2026-10-27T07:20:00.000Z", generation: 1, runsOn: { kind: "device", deviceId: studio }, listedAt: "2026-10-27T07:20:01.000Z", ...extra,
  })
  const working = row("working")
  const waiting = row("waiting", { waitingOn: "Approve: npm test" })
  const failed = row("failed")
  const inCloud = row("working", { runsOn: { kind: "cloud", threadId: "t-00000000000000ac" } })
  const since = "2026-10-27T08:00:00.000Z"
  machine.account.sessionListings = async () => ({ sessions: [working, waiting, failed, inCloud], seq: 3, quiet: [{ deviceId: studio, since }] })
  machine.account.devices = async () => ({ devices: [{ id: studio, name: "Studio" }], current: myDevice! })
  const listeners = new Set<(heard: AccountListHeard | "account-changed") => void>()
  machine.account.onThreadListings = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const say = (heard: AccountListHeard) => {
    for (const listener of listeners) listener(heard)
  }
  const router = new CloudConversations({ account: () => machine.account, file: join(await mkdtemp(join(tmpdir(), "mako-quiet-")), "conversations.json"), emit: () => {}, repositoryOf: async () => REPOSITORY })
  after(() => router.dispose())
  await router.start()
  const shown = (each: ListedSession) => router.summaries().find((summary) => summary.session.id === each.conversation)
  const states = () => [working, waiting, failed, inCloud].map((each) => [shown(each)?.session.status, shown(each)?.waitingOn])
  await until("the list read and listed here", () => shown(working)?.elsewhere === "Studio")
  assert.deepEqual(states(), [["ready", undefined], ["ready", undefined], ["failed", undefined], ["running", undefined]], "nothing on the quiet Studio shown at work or asking; the cloud machine's is")
  assert.deepEqual([working, failed, inCloud].map((each) => shown(each)?.quietSince), [Date.parse(since), Date.parse(since), undefined], "and when the Studio was last heard from, for the rail to say")

  say({ seq: 4, event: { type: "device-quiet", deviceId: studio, since: null } })
  assert.deepEqual(states(), [["running", undefined], ["running", "Approve: npm test"], ["failed", undefined], ["running", undefined]], "back: each as it last said")
  assert.equal(shown(working)?.quietSince, undefined)
  say({ seq: 5, event: { type: "device-quiet", deviceId: studio, since } })
  assert.deepEqual(states().slice(0, 2), [["ready", undefined], ["ready", undefined]], "and quiet again")
})

test("another Mac's conversation while that Mac is off reads from the copy it keeps in the account, saying so, a page at a time; anything else is refused, saying why", async () => {
  const machine = await cloudMachine()
  const myDevice = await machine.account.deviceId()
  const studio = "3d0f6c2a-8b1e-4f7a-9c5d-2e1b0a9f8d7c"
  const conversation = randomUUID()
  const listed: ListedSession = {
    session: randomUUIDFor(conversation), thread: "6f1c9a52-0d4e-4b8e-9a51-3f2c7d1e8b40", conversation, harness: "claude", title: "Retry the webhooks", state: "idle",
    folder: CLONE, createdAt: "2026-10-24T20:00:00.000Z", activityAt: "2026-10-24T20:00:00.000Z", generation: 1, nativeId: "0b7e", runsOn: { kind: "device", deviceId: studio }, listedAt: "2026-10-24T20:00:01.000Z",
  }
  machine.account.sessionListings = async () => ({ sessions: [listed], seq: 1 })
  machine.account.devices = async () => ({ devices: [{ id: studio, name: "Studio" }], current: myDevice! })
  let tell: ((heard: AccountListHeard | "account-changed") => void) | undefined
  machine.account.onThreadListings = (listener) => ((tell = listener), () => {})
  // The Studio's copy: 250 entries, written at 21:10.
  const at = Date.parse("2026-10-24T21:10:00.000Z")
  const entries = Array.from({ length: 250 }, (_, n) => ({ id: `e-${n}`, type: "text" as const, text: `answer ${n}` }))
  const asked: string[] = []
  const copies: CloudCopies = {
    page: async (device, harness, nativeId, before, limit) => {
      asked.push(`${device} ${harness} ${nativeId} ${before ?? "newest"}`)
      const end = before ?? entries.length
      const start = Math.max(0, end - limit)
      return { header: { copy: 1, harness, nativeId, title: "Retry the webhooks", cwd: CLONE, translator: "t-1", total: entries.length, stamp: "n:7", at }, entries: entries.slice(start, end), start, total: entries.length }
    },
    entry: async (_device, _harness, _nativeId, id) => entries.find((entry) => entry.id === id) ?? null,
  }
  const { router, events } = conversations(machine.account, join(scratch, "copies", "conversations.json"), copies, 200)
  await router.start()
  await until("listed", () => router.summaries().some((summary) => summary.session.id === conversation))

  // The Studio isn't connected: the cloud refuses the call unapplied, and the copy answers.
  const opened = await router.route("mako:live-snapshot", [conversation])
  assert.ok(opened.handled)
  const cursor = z.object({ blocks: z.number(), base: z.number() })
  const snapshot = z.object({
    copy: z.object({ at: z.number() }).optional(),
    elsewhere: z.string().optional(),
    session: z.object({ status: z.string(), connection: z.string() }).loose(),
    requests: z.array(z.unknown()),
    blocks: z.array(z.unknown()),
    base: z.object({ start: z.number(), hasEarlier: z.boolean(), entries: z.array(z.object({ id: z.string() }).loose()) }).loose().nullable(),
    history: z.object({ token: z.string(), before: cursor.nullable() }).loose().optional(),
  }).loose().parse(decodeRuntimeValue(opened.value))
  assert.deepEqual(snapshot.copy, { at }, "read from the account's copy, as the Studio wrote it at 21:10")
  assert.equal(snapshot.elsewhere, "Studio")
  assert.deepEqual([snapshot.session.status, snapshot.session.connection, snapshot.requests.length, snapshot.blocks.length], ["ready", "hibernated", 0, 0], "nothing runs while its Mac is off")
  assert.equal(snapshot.base?.entries.at(-1)?.id, "e-249", "its newest entries")
  assert.equal(snapshot.base?.hasEarlier, true)
  assert.ok(snapshot.history, "a window pages it as it pages any conversation's history")
  assert.deepEqual(asked, [`${studio} claude 0b7e newest`], "by its device and native session")

  // An earlier page, through the same history reads a window makes.
  const earlier = await router.route("mako:live-read", [conversation, { kind: "earlier", token: snapshot.history!.token, before: snapshot.history!.before! }])
  assert.ok(earlier.handled)
  const chunk = z.object({ data: z.string(), next: z.number().nullable() }).loose().parse(decodeRuntimeValue(earlier.value))
  assert.equal(chunk.next, null, "a page in one part")
  const page = z.object({ base: z.object({ start: z.number(), entries: z.array(z.object({ id: z.string() }).loose()) }).loose() }).loose().parse(JSON.parse(chunk.data))
  assert.equal(page.base.entries.at(-1)?.id, `e-${snapshot.base!.start - 1}`, "the page before what it holds")

  // A message for it waits in the account under its own ID, at once (a Mac isn't woken by being called), and windows
  // read the conversation again, its message queued for the Studio.
  const waited: unknown[][] = []
  let held: WaitingMessage[] = []
  machine.account.waitMessage = async (session, id, input) => {
    waited.push(["wait", session, id, input])
    held = [...held.filter((each) => each.id !== id), { ...input, id, session, from: myDevice!, at: new Date().toISOString() }]
    return held
  }
  machine.account.editWaiting = async (session, id, expectedText, text) => (waited.push(["edit", session, id, expectedText, text]), held)
  machine.account.unwaitMessage = async (session, id) => (waited.push(["unwait", session, id]), (held = held.filter((each) => each.id !== id)))
  const requestId = randomUUID()
  const asking = performance.now()
  const listedBeforeWait = events.filter((event) => event.type === "live-listed").length
  const sent = await router.route("mako:live-prompt", [conversation, requestId, "Merge it once CI is green", [], undefined])
  assert.ok(sent.handled)
  assert.ok(performance.now() - asking < 1_000, "at once: a Mac isn't woken by being called")
  assert.deepEqual(z.object({ id: z.string(), status: z.string() }).loose().parse(decodeRuntimeValue(sent.value)), { id: requestId, text: "Merge it once CI is green", attachments: [], status: "queued" })
  assert.deepEqual(waited, [["wait", listed.session, requestId, { conversation, text: "Merge it once CI is green" }]], "kept by the account, for the Session, by the conversation the list named")
  assert.ok(events.filter((event) => event.type === "live-listed").length > listedBeforeWait, "windows read it again")
  await assert.rejects(router.route("mako:live-prompt", [conversation, randomUUID(), "look", [{ name: "shot.png", mimeType: "image/png", data: "AA==" }], undefined]), /A message with files can't wait for it/)
  // The account's stream says it waits: the copy's snapshot has it queued. Then it's edited and taken back on the account's.
  tell?.({ seq: 2, event: { type: "messages-waiting", session: listed.session, messages: held } })
  const queued = await router.route("mako:live-snapshot", [conversation])
  assert.ok(queued.handled)
  const withWaiting = z.object({ requests: z.array(z.object({ id: z.string(), status: z.string() }).loose()) }).loose().parse(decodeRuntimeValue(queued.value))
  assert.deepEqual(withWaiting.requests.map((each) => [each.id, each.status]), [[requestId, "queued"]])
  await router.route("mako:live-edit-queued", [conversation, { requestId, expectedText: "Merge it once CI is green", change: { kind: "edit", text: "Merge it once CI is green, then tag it" } }])
  await router.route("mako:live-edit-queued", [conversation, { requestId, expectedText: "Merge it once CI is green, then tag it", change: { kind: "remove" } }])
  assert.deepEqual(waited.slice(1), [["edit", listed.session, requestId, "Merge it once CI is green", "Merge it once CI is green, then tag it"], ["unwait", listed.session, requestId]])

  // The Studio comes back: a window with its conversation open is told, and reads it there again, live.
  const studioCalls: string[] = []
  const studioRuntime = await serveHostThroughGateway(await machine.gateway.connectRuntime(), {
    runtimeId: `d-${studio}`,
    build: "test",
    invoke: async (channel) => (studioCalls.push(channel), JSON.stringify({ session: { id: conversation } })),
  })
  after(() => studioRuntime.close())
  const listedBefore = events.filter((event) => event.type === "live-listed").length
  await until("the window told the Studio is back", () => events.filter((event) => event.type === "live-listed").length > listedBefore, 5_000)
  assert.ok(studioCalls.includes("mako:live-state"), "asked with the smallest read there is")
  studioCalls.length = 0
  await router.route("mako:live-snapshot", [conversation])
  assert.deepEqual(studioCalls, ["mako:live-snapshot"], "and read on the Studio, not from its copy")
})

/**
 * One of this Mac's conversations in a Thread its store has, a router that routes it, the cloud Threads it may move to,
 * and the account's list, which hears of each move from the cloud a moment after it: moved and brought back as
 * `CloudMoves` and `CloudReturns` leave this Mac's store, with each call's cloud Thread recorded.
 */
async function movingThread(name: string, threadIds: string[]) {
  const machine = await cloudMachine()
  const targets: string[] = []
  const session = machine.account.session
  machine.account.session = () => {
    const opened = session()
    return { ...opened, call: (operation) => (targets.push(operation.target.kind === "thread" ? operation.target.threadId : operation.target.runtimeId), opened.call(operation)) }
  }
  const folder = join(scratch, name)
  await mkdir(folder, { recursive: true })
  let clock = 1_000
  const store = new ThreadStore(join(folder, "threads.sqlite"), { now: () => clock++, realPath: (path) => path })
  after(() => store.close())
  const conversation = randomUUID()
  const placed = store.registerJournal({ conversationId: conversation, createdAt: clock++, harness: "opencode", bindings: [{ provider: "opencode", nativeId: "ses-0", path: "/opencode/ses-0.json" }] }, store.person())
  for (const threadId of threadIds) await machine.account.createThread(threadId, REPOSITORY)

  const myDevice = await machine.account.deviceId()
  let tell: ((heard: AccountListHeard | "account-changed") => void) | undefined
  let seq = 1
  machine.account.sessionListings = async () => ({ sessions: [], seq })
  machine.account.devices = async () => ({ devices: [], current: myDevice! })
  machine.account.onThreadListings = (listener) => ((tell = listener), () => {})
  const returning = new Map<string, Promise<void>>()
  const events: RuntimeEvent[] = []
  const router = new CloudConversations({
    account: () => machine.account, file: join(folder, "conversations.json"), emit: (event) => events.push(event), repositoryOf: async () => REPOSITORY,
    threads: () => store, returning: (threadId) => returning.get(threadId),
  })
  after(() => router.dispose())
  await router.start()
  await until("the list read", () => tell !== undefined)

  return {
    store, conversation, router, targets, events,
    /** The account's list says the conversation's Session runs on `threadId`, under `generation`. */
    listed: (threadId: string, generation: number, title = "Carry .env") => tell?.({ seq: ++seq, event: { type: "sessions-listed", sessions: [{
      session: placed.session, thread: placed.thread, conversation, harness: "opencode", title, state: "idle", folder: CLONE,
      createdAt: "2026-10-27T07:20:00.000Z", activityAt: "2026-10-27T07:20:00.000Z", generation, runsOn: { kind: "cloud", threadId }, listedAt: "2026-10-27T07:20:01.000Z",
    }] } }),
    /** A move up to the cloud's claim: released here, then the cloud's. The generation the claim gave it. */
    moveTo: (threadId: string) => {
      const runtime = cloudRuntimeOf(threadId)
      const move = MoveIdSchema.parse(randomUUID())
      store.beginMove({ move, thread: placed.thread, target: { kind: "cloud", runtime }, actor: store.person() })
      const handoff = store.release({ operationId: randomUUID(), move, actor: store.person() })
      store.confirm({ operationId: randomUUID(), receipt: { move, owner: { kind: "cloud", runtime }, sessions: handoff.sessions.map((each) => ({ id: each.id, generation: each.generation + 1 })) }, actor: store.person() })
      return store.execution(placed.session)!.generation
    },
    /** The move answers: this Mac follows the conversation on `threadId`, as the machine started it. */
    moved: async (threadId: string) => {
      await router.adopt({ conversationId: conversation, threadId, harness: "opencode", repository: REPOSITORY })
      router.started(conversation, encodeRuntimeValue({ session: { id: conversation, harness: "opencode", cwd: CLONE, status: "ready", nativeId: "ses-0" }, revision: 1, createdAt: 1 }))
    },
    /** A return of `threadId` begins: until `over`, nothing runs it. */
    returnFrom: (threadId: string) => {
      let over = () => {}
      returning.set(threadId, new Promise<void>((resolve) => (over = resolve)))
      return () => {
        returning.delete(threadId)
        over()
      }
    },
    /** The return brought it back: this Mac's store claims it, and each conversation is answered here again. */
    back: async (threadId: string) => {
      claimBack(store, placed.thread, cloudRuntimeOf(threadId), clock++)
      assert.deepEqual(await router.releaseThread(threadId), [conversation])
    },
    /** The cloud Threads a call went to. */
    sentTo: async (call: Promise<unknown>) => {
      targets.length = 0
      await call
      return [...targets]
    },
    read: () => router.route("mako:live-read", [conversation, { kind: "snapshot" }]),
    /** What windows heard listed or unlisted. */
    heard: () => events.filter((event) => event.type === "live-listed" || event.type === "live-unlisted").length,
  }
}

test("a Thread moved to the cloud, brought back and moved again: from each move's answer every call goes to the cloud Thread it named, from the return's every call is this Mac's, and the account's list, a moment behind, changes neither", async () => {
  const [first, second] = ["t-00000000000000b1", "t-00000000000000b2"]
  const thread = await movingThread("again", [first, second])
  const { router, conversation, read, sentTo } = thread

  // First move. The cloud's claim reaches the list before the move's answer reaches this Mac, as it did on production.
  const firstGeneration = thread.moveTo(first)
  thread.listed(first, firstGeneration)
  await thread.moved(first)
  assert.deepEqual(await sentTo(read()), [first])
  const remembered = z.object({ conversations: z.array(z.object({ conversationId: z.string(), threadId: z.string() }).loose()) }).parse(JSON.parse(await readFile(join(scratch, "again", "conversations.json"), "utf8")))
  assert.deepEqual(remembered.conversations.map((entry) => [entry.conversationId, entry.threadId]), [[conversation, first]], "the move's, remembered, not a row of the list's")
  // A window opens its folder there, and keeps it until it hears the conversation moved.
  const kept = await router.folder(conversation)
  assert.ok(kept)
  assert.deepEqual(await sentTo(kept.call("mako:git-status", [])), [first])
  const heardOfFirst = thread.heard()

  // Brought back. The list still says the cloud Thread runs it: it trails the return, and whatever else it says is heard.
  await thread.back(first)
  thread.listed(first, firstGeneration, "Carry .env, changed here")
  assert.equal(router.has(conversation), false, "its journal here is the one windows list")
  assert.deepEqual(await sentTo(read()), [], "answered here")
  assert.deepEqual(await read(), { handled: false })
  assert.equal(await kept.call("mako:git-status", []), "here", "its folder too")
  assert.equal(thread.heard(), heardOfFirst, "nothing listed it where it no longer runs")

  // Changed here, moved again, to a new cloud Thread, while the list still names the first: the calls the window makes
  // as the move answers (its folder's Git, the transcript, the app) go to the second, as does every one after.
  const secondGeneration = thread.moveTo(second)
  await thread.moved(second)
  const opened = await router.folder(conversation)
  assert.ok(opened)
  assert.deepEqual(await sentTo(Promise.all([opened.call("mako:git-status", []), read(), opened.call("mako:thread-app-start", [CLONE])])), [second, second, second])
  assert.deepEqual(await sentTo(kept.call("mako:git-status", [])), [second], "a window that kept its folder from the first move reads the second's")
  thread.listed(first, firstGeneration, "Carry .env, changed again")
  assert.deepEqual(await sentTo(read()), [second], "a row from before the return changes nothing")
  thread.listed(second, secondGeneration)
  assert.deepEqual(await sentTo(read()), [second], "nor the list catching up")
  assert.equal(thread.heard(), heardOfFirst, "nor did windows hear of it from the list")
})

test("a call made while a Thread comes back waits for the return, then goes where the Thread runs after: still the cloud if it stayed, here once it's back", async () => {
  const cloudThread = "t-00000000000000c1"
  const thread = await movingThread("meanwhile", [cloudThread])
  const { router, conversation, read, targets } = thread
  thread.moveTo(cloudThread)
  await thread.moved(cloudThread)
  const folder = await router.folder(conversation)
  assert.ok(folder)
  const calls = () => [read(), folder.call("mako:git-status", []), folder.call("mako:thread-app-start", [CLONE])] as const
  const settled = async (pending: readonly Promise<unknown>[]) => {
    let done = 0
    for (const each of pending) void each.then(() => done++, () => done++)
    await new Promise((resolve) => setTimeout(resolve, 50))
    return done
  }

  // A return the cloud refused: the Thread stayed, and what waited goes to it there.
  targets.length = 0
  let over = thread.returnFrom(cloudThread)
  let pending = calls()
  assert.equal(await settled(pending), 0, "each waits while nothing runs the Thread")
  assert.deepEqual(targets, [], "and nothing reaches the cloud Thread, which refuses work on the way back")
  over()
  const [stayedRead, stayedStatus, stayedApp] = await Promise.all(pending)
  assert.ok(stayedRead.handled && stayedStatus !== "here" && stayedApp !== "here", "answered in the cloud")
  assert.deepEqual(targets, [cloudThread, cloudThread, cloudThread])

  // A return that brings it back: what waited is answered here, and nothing goes to the machine that gave it up.
  targets.length = 0
  over = thread.returnFrom(cloudThread)
  pending = calls()
  assert.equal(await settled(pending), 0)
  await thread.back(cloudThread)
  over()
  assert.deepEqual(await Promise.all(pending), [{ handled: false }, "here", "here"], "each answered here")
  assert.deepEqual(targets, [])
})

test("a message that waited in the account for this Mac's own Session is taken here once, under its own ID, and the account told; one for a Session this Mac no longer owns is left for its owner", async () => {
  const machine = await cloudMachine()
  const myDevice = await machine.account.deviceId()
  const mine = randomUUID()
  const moved = randomUUID()
  const row = (session: string, conversation: string): ListedSession => ({
    session, thread: "6f1c9a52-0d4e-4b8e-9a51-3f2c7d1e8b40", conversation, harness: "claude", title: "Retry the webhooks", state: "idle",
    createdAt: "2026-10-24T20:00:00.000Z", activityAt: "2026-10-24T20:00:00.000Z", generation: 1, runsOn: { kind: "device", deviceId: myDevice! }, listedAt: "2026-10-24T20:00:01.000Z",
  })
  const message = (session: string, conversation: string, text: string): WaitingMessage => ({ id: randomUUID(), session, conversation, text, from: "3d0f6c2a-8b1e-4f7a-9c5d-2e1b0a9f8d7c", at: "2026-10-25T09:00:00.000Z" })
  const first = message(mine, "c-mine", "Merge it once CI is green")
  const elsewhere = message(moved, "c-moved", "Tag the release")
  let tell: ((heard: AccountListHeard | "account-changed") => void) | undefined
  machine.account.sessionListings = async () => ({ sessions: [row(mine, "c-mine"), row(moved, "c-moved")], seq: 1, waiting: [first, elsewhere] })
  machine.account.devices = async () => ({ devices: [], current: myDevice! })
  machine.account.onThreadListings = (listener) => ((tell = listener), () => {})
  const acked: string[] = []
  machine.account.tookWaiting = async (_session, id) => void acked.push(id)
  const taken: string[] = []
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => (release = resolve))
  const options: CloudConversationsOptions = {
    account: () => machine.account, file: join(scratch, "taking", "conversations.json"), emit: () => {}, repositoryOf: async () => REPOSITORY,
    takeWaiting: async (waiting) => {
      if (waiting.session === moved) return "not-mine"
      taken.push(waiting.id)
      await held
      return "taken"
    },
  }
  const router = new CloudConversations(options)
  after(() => router.dispose())
  await router.start()
  await until("taken here", () => taken.length === 1)
  // Heard again while it's being taken (the stream said it too): taken once.
  tell?.({ seq: 2, event: { type: "messages-waiting", session: mine, messages: [first] } })
  release?.()
  await until("the account told", () => acked.length === 1)
  assert.deepEqual([taken, acked], [[first.id], [first.id]], "taken once, under its own ID, then said")
  assert.ok(!acked.includes(elsewhere.id), "a Session this Mac no longer owns: its owner takes it")
  tell?.({ seq: 3, event: { type: "messages-waiting", session: mine, messages: [] } })
  assert.equal(taken.length, 1)
})

/** This Mac's store takes back a Thread that ran on the cloud runtime `runtime`, as a return's claim does (`CloudReturns`). */
function claimBack(store: ThreadStore, thread: ThreadId, runtime: RuntimeId, releasedAt: number): void {
  const here = store.threadHandoff(thread)
  const handoff = { move: MoveIdSchema.parse(randomUUID()), source: { kind: "cloud" as const, runtime }, target: store.self, releasedAt, thread: here.thread, sessions: here.sessions.map((each) => ({ ...each, generation: each.generation + 1 })) }
  store.claim({ operationId: randomUUID(), handoff, actor: store.person() })
}

/** A Session ID for a conversation, the same each time it's asked. */
function randomUUIDFor(conversation: string): string {
  const known = sessionIds.get(conversation) ?? randomUUID()
  sessionIds.set(conversation, known)
  return known
}
const sessionIds = new Map<string, string>()

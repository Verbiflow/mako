import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
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
import { CloudConversations, folderRepository } from "@mako/host/conversations/cloud-conversations"
import type { CloudPrepareLaunch, CloudRepository } from "@mako/host/contracts/cloud-threads"
import { githubRepositoryUrl } from "@mako/host/contracts/cloud-threads"
import { decodeRuntimeValue, encodeRuntimeEvent, runtimeEventLine, type RuntimeEvent } from "@mako/host/contracts/runtime-value"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"
import type { CloudAccount } from "@mako/host/usage/cloud-account-methods"
import { z } from "zod"

/** A move's calls and its way back's, which these conversations never make (`test-cloud-moves.ts` covers them). */
const unused = () => Promise.reject(new Error("no move in this test"))
const movesUnused: Pick<CloudAccount, "sendCheckpoint" | "claimMove" | "refuseMove" | "moveAnswer" | "threadRecords" | "readCheckpoint" | "beginReturn" | "releaseReturn" | "cancelReturn" | "giveBackReturn" | "finishReturn" | "returnState"> = {
  sendCheckpoint: unused,
  claimMove: unused,
  refuseMove: unused,
  moveAnswer: unused,
  threadRecords: unused,
  readCheckpoint: unused,
  beginReturn: unused,
  releaseReturn: unused,
  cancelReturn: unused,
  giveBackReturn: unused,
  finishReturn: unused,
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

/** A cloud machine's host behind the fake gateway: what it was asked, and its Thread's event outbox. */
async function cloudMachine(reach: Reach = {}) {
  const gateway = createFakeGateway()
  const runtimeId = "m-0123456789abcdef.g1"
  const threads = new RuntimeThreads()
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const served = await serveHostThroughGateway(await gateway.connectRuntime(), {
    runtimeId,
    build: "test",
    threads,
    invoke: async (channel, args) => {
      calls.push({ channel, args })
      if (channel === "mako:boot") return JSON.stringify({ activeTabId: "tab-1", tabs: [{ id: "tab-1", session: { meta: { cwd: CLONE } } }] })
      if (channel === "mako:thread-app") return JSON.stringify({ kind: "ready", project: "Hello-World", phase: "running", address: { host: "t.thread.localhost", port: 20000 }, processes: [], checks: [] })
      if (channel === "mako:live-start") {
        const [harness, cwd, options] = z.tuple([z.string(), z.string(), z.object({ conversationId: z.string() }).loose()]).parse(args)
        return JSON.stringify({ session: { id: options.conversationId, harness, cwd, status: "running" }, revision: 1, createdAt: 1, requests: [] })
      }
      return JSON.stringify({ channel })
    },
  })
  after(() => served.close())
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
  const batch = (threadId: string, conversation: string, revision: number, status: string) => {
    // SAFETY: a batch as the machine's live driver sends it, filled only as far as the router and summary read it.
    const event = encodeRuntimeEvent({ type: "live-batch", batch: { id: conversation, revision, updates: [], sessionChanges: { status } } } as never)
    return threads.emit(threadId, Payload.encoded(runtimeEventLine("event", event).slice(0, -1)))
  }
  return { account, calls, created, asked, machineState, bases, batch, network, served }
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
function conversations(account: CloudAccount, file: string) {
  const events: RuntimeEvent[] = []
  const starts: RuntimeEvent[] = []
  /** Each conversation a window on its folder was told changed, in order. */
  const changed: string[] = []
  const router = new CloudConversations({ account: () => account, file, emit: (event) => (event.type === "cloud-start-step" ? starts : events).push(event), repositoryOf: async () => REPOSITORY, changed: (id) => changed.push(id) })
  after(() => router.dispose())
  return { router, events, starts, changed }
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
    assert.deepEqual(decodeRuntimeValue(status), { channel: "mako:git-status" }, "the machine's host answered")
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

test("a cloud app's view is asked passively, its address is this Mac's preview of the port, and while its machine sleeps the last one is shown", async () => {
  const machine = await cloudMachine()
  const passive: boolean[] = []
  const session = machine.account.session
  machine.account.session = () => {
    const opened = session()
    return { ...opened, call: (operation) => (operation.op === "host.thread-app" && passive.push(operation.passive === true), opened.call(operation)) }
  }
  const { router } = conversations(machine.account, join(scratch, "app-view", "conversations.json"))
  const conversationId = randomUUID()
  await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId, cloud: { repository: REPOSITORY } }])
  const folder = await router.folder(conversationId)
  const ViewSchema = z.object({ kind: z.string(), phase: z.string(), address: z.object({ host: z.string(), port: z.number() }) }).loose()
  const view = ViewSchema.parse(decodeRuntimeValue(await folder!.call("mako:thread-app", [CLONE])))
  assert.equal(view.phase, "running")
  assert.equal(view.address.host, `${machine.created[0]}.cloud.localhost`, "the app at this Mac's preview of its port")
  assert.notEqual(view.address.port, 20000)
  assert.deepEqual(passive, [true], "a window's look, never a person's call")
  // The machine goes to sleep: no runtime answers; the window is shown the last view, and nothing waits or wakes.
  await machine.served.close()
  const started = performance.now()
  const asleep = ViewSchema.parse(decodeRuntimeValue(await folder!.call("mako:thread-app", [CLONE])))
  assert.deepEqual(asleep, view)
  assert.ok(performance.now() - started < 1_000, "answered at once, never waited out")
  assert.deepEqual(passive, [true, true])
})

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
  Payload,
  RuntimeThreads,
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
import type { CloudRepository } from "@mako/host/contracts/cloud-threads"
import { githubRepositoryUrl } from "@mako/host/contracts/cloud-threads"
import { decodeRuntimeValue, encodeRuntimeEvent, runtimeEventLine, type RuntimeEvent } from "@mako/host/contracts/runtime-value"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"
import type { CloudAccount } from "@mako/host/usage/cloud-account-methods"
import { z } from "zod"

const CLONE = "/home/node/work/octocat/Hello-World"
const REPOSITORY: CloudRepository = { url: "https://github.com/octocat/Hello-World" }
const scratch = await mkdtemp(join(tmpdir(), "mako-cloud-conversations-"))
after(() => rm(scratch, { recursive: true, force: true }))

/** How this Mac reaches the cloud: in memory, or over real sockets that can go silent as a sleeping Mac's do. */
type Reach = { sockets?: { heartbeatMs: number; silentMs?: number; wakeProbeMs?: number } }

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
  const account: CloudAccount = {
    token: async () => "token",
    id: async () => "account",
    deviceId: async () => deviceId,
    session: () =>
      network && reach.sockets
        ? clientSessionOverSockets(() => new WebSocket(network.url), reach.sockets)
        : sessionOf(client),
    createThread: async (threadId, repository) => {
      assert.deepEqual(repository, REPOSITORY)
      created.push(threadId)
      await gateway.assign(threadId, runtimeId)
    },
    wake: () => {},
    stop: () => {},
  }
  /** One of the machine host's live batches, on its Thread's stream as the machine sends it. */
  const batch = (threadId: string, conversation: string, revision: number, status: string) => {
    // SAFETY: a batch as the machine's live driver sends it, filled only as far as the router and summary read it.
    const event = encodeRuntimeEvent({ type: "live-batch", batch: { id: conversation, revision, updates: [], sessionChanges: { status } } } as never)
    return threads.emit(threadId, Payload.encoded(runtimeEventLine("event", event).slice(0, -1)))
  }
  return { account, calls, created, batch, network }
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
    close: () => {},
    wake: () => {},
  }
}

function conversations(account: CloudAccount, file: string) {
  const events: RuntimeEvent[] = []
  const router = new CloudConversations({ account: () => account, file, emit: (event) => events.push(event), repositoryOf: async () => REPOSITORY })
  after(() => router.dispose())
  return { router, events }
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

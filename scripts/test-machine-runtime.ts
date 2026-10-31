/**
 * The host as a cloud machine's runtime, against a fake gateway over a real WebSocket, with the test playing the
 * machine's agent on the other end of its channel: linking with a credential, operations for the Thread answered
 * through the host's dispatcher, the host's events delivered as the Thread's in order and once across a dropped
 * connection, an oversized live batch sent as the notice to read it, a clock jump reported, an unlink silencing it,
 * and a restarted host numbering after what it reserved.
 */
import type { MachineGatewayLink } from "@mako/host/usage/machine-runtime"
import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { duplexPair } from "node:stream"
import { after, test } from "node:test"
import { WebSocketServer, type WebSocket as ServerSocket } from "ws"
import { z } from "zod"
import { LIVE_FORM, PING, PONG, SUBPROTOCOL, WHOLE_LIVE_FORM, decodeRuntimeFrame, encodeGatewayFrame, offeredCredential, sessionStream, threadStream, type Actor, type LiveForm, type MediaHandler, type Subscription } from "@mako/protocol"
import { createFakeGateway, type FakeGatewayOptions, type GatewayLogLine } from "@mako/protocol/fake-gateway"
import { compactLiveBatch, type LiveBatch } from "@mako/host/contracts/live-conversations"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { MachineRuntime, type MachineRuntimeOptions } from "@mako/host/usage/machine-runtime"
import { hostLog, hostWarn } from "@mako/host/base/host-log"
import type { AgentMessage, HostMessage, MachineRuntimeState } from "@mako/host/contracts/machine-agent"
import { hostCallInput, hostOperations, hostReplyValue, toHostOperation } from "@mako/host/contracts/host-operations"
import type { ReportedSession } from "@mako/protocol/thread-listing"
import { SessionPublisher } from "@mako/host/conversations/session-report"
import type { LifecycleWork } from "@mako/host/contracts/app-lifecycle"
import { encodeRuntimeEvent, readEventLine, type RuntimeEvent } from "@mako/host/contracts/runtime-value"
import { cpuBetween, type CpuSample } from "@mako/host/usage/process-cpu"
import { HostProfiler } from "@mako/host/usage/host-profile"

const scratch = await mkdtemp(join(tmpdir(), "mako-machine-runtime-"))
after(() => rm(scratch, { recursive: true, force: true }))

const RUNTIME = "m-0123456789abcdef.g1"
const CREDENTIAL = `mmc_${"k".repeat(43)}`
const desktop: Actor = { kind: "client", client: "desktop", deviceId: "d-1" }

/** The gateway's runtime route over a fake gateway: the machine credential checked at the upgrade, then frames carried both ways. */
async function machineGateway(runtimeId = RUNTIME, options: FakeGatewayOptions = {}) {
  const gateway = createFakeGateway(options)
  /** The credentials the Machine object takes now. */
  const accepted = new Set([CREDENTIAL])
  const sockets = new Set<ServerSocket>()
  let upgrades = 0
  /** Connections that answer nothing, as one dead across a pause looks before its close arrives. */
  const silent = new Set<ServerSocket>()
  const started = Date.now()
  /** When each upgrade came, less those within 100 ms of the one before. */
  const attempts: number[] = []
  const server = createServer((_request, response) => response.writeHead(404).end())
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false) })
  server.on("upgrade", (request, socket, head) => {
    upgrades += 1
    const at = Date.now() - started
    if (!attempts.length || at - attempts.at(-1)! > 100) attempts.push(at)
    const path = new URL(request.url ?? "/", "http://gateway").pathname
    if (path !== `/v1/runtimes/${runtimeId}/connect` || !accepted.has(offeredCredential(request.headers["sec-websocket-protocol"]) ?? "")) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n")
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws)
      void gateway.connectRuntime().then((link) => {
        ws.on("message", (data) => {
          if (silent.has(ws)) return
          const text = String(data)
          if (text === PING) return ws.send(PONG)
          decodeRuntimeFrame(text)
          link.sendUnchecked(text)
        })
        ws.on("close", () => {
          sockets.delete(ws)
          link.close()
        })
        void (async () => {
          for await (const frame of link.frames()) if (ws.readyState === ws.OPEN) ws.send(encodeGatewayFrame(frame))
        })()
      })
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  after(() => {
    for (const socket of sockets) socket.terminate()
    server.close()
  })
  // SAFETY: a server listening on a TCP port, not a pipe, has an AddressInfo address.
  const { port } = server.address() as AddressInfo
  return {
    gateway,
    accepted,
    url: `http://127.0.0.1:${port}`,
    upgrades: () => upgrades,
    attempts: () => attempts,
    connected: () => sockets.size,
    /** The connections open now answer nothing from here on; a new one is answered. */
    silence: () => {
      for (const socket of sockets) silent.add(socket)
    },
    /** The connection drops as a network change would drop it, with no close frame. */
    drop: () => {
      for (const socket of sockets) socket.terminate()
    },
  }
}

/** The machine's agent: its end of the host's channel, and every message the host sent on it. */
function machineAgent(options: { dataRoot: string; now?: () => number; work?: () => LifecycleWork[]; sessions?: SessionPublisher; media?: () => MediaHandler | undefined; sampleCpu?: () => Promise<CpuSample | undefined>; restore?: MachineRuntimeOptions["restore"]; saves?: MachineRuntimeOptions["saves"] }) {
  const [agentEnd, hostEnd] = duplexPair()
  const messages: HostMessage[] = []
  // SAFETY: the host under test writes only HostMessage lines on its channel; the assertions read what it said.
  createInterface({ input: agentEnd }).on("line", (line) => messages.push(JSON.parse(line) as HostMessage))
  const calls: string[] = []
  const workspaces: string[] = []
  const prepared: string[] = []
  const prefetched: string[] = []
  const signedIn: string[] = []
  const installs: Array<{ harnesses: string[]; secrets: string }> = []
  const links: Array<MachineGatewayLink | null> = []
  const carried: string[][] = []
  const runtime = new MachineRuntime({
    agent: hostEnd,
    invoke: async (channel, args, client, _history, correlationId) => {
      calls.push(channel)
      return JSON.stringify({ channel, args, client, correlationId })
    },
    openWorkspace: async (path) => {
      workspaces.push(path)
      if (path.endsWith("/missing")) throw new Error("no such folder")
      if (path.endsWith("/slow")) await new Promise((resolve) => setTimeout(resolve, 300))
    },
    prepareFolder: async (path) => {
      prepared.push(path)
      if (path.endsWith("/missing")) throw new Error("no such folder")
    },
    prefetchStart: async (harness) => {
      prefetched.push(harness)
      return harness === "none" ? undefined : { answered: true, stopped: false, ms: 12, readMiB: 230, readMs: 800 }
    },
    prefetchSignedIn: async (harness) => {
      signedIn.push(harness)
      return { ms: 7 }
    },
    version: "0.0.0-test",
    build: "test",
    dataRoot: options.dataRoot,
    work: options.work ?? (() => []),
    sessions: options.sessions,
    media: options.media ?? (() => undefined),
    sampleCpu: options.sampleCpu ?? (async () => undefined),
    profileHost: false,
    now: options.now ?? Date.now,
    linked: async (link) => void links.push(link),
    ...options.restore && { restore: options.restore },
    ...options.saves && { saves: options.saves },
    carriedFiles: (files) => void carried.push(files.flatMap((file) => file.names)),
    installSignIns: async (signIns, secrets) => {
      installs.push({ harnesses: signIns.map((signIn) => signIn.harness), secrets })
      await new Promise((resolve) => setTimeout(resolve, 20))
      return signIns.map((signIn) =>
        signIn.harness === "grok"
          ? { harness: signIn.harness, status: "failed" as const, at: new Date().toISOString(), reason: "no key" }
          : { harness: signIn.harness, status: "installed" as const, at: new Date().toISOString(), expiresAt: signIn.expiresAt },
      )
    },
  })
  runtime.start()
  after(() => runtime.stop())
  const state = (): MachineRuntimeState | undefined => messages.findLast((message) => message.type === "state")?.state
  return {
    runtime,
    messages,
    calls,
    workspaces,
    prepared,
    prefetched,
    signedIn,
    installs,
    links,
    carried,
    state,
    tell: (message: AgentMessage) => agentEnd.write(`${JSON.stringify(message)}\n`),
    /** A line no agent of this version sends. */
    tellRaw: (line: string) => agentEnd.write(`${line}\n`),
    until: async (what: string, check: () => boolean, ms = 5_000) => {
      for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 10))) if (check()) return
      assert.fail(`${what} within ${ms} ms; the host said ${JSON.stringify(state())}`)
    },
  }
}

const HostEventLineSchema = z.object({ channel: z.string(), type: z.string().optional(), payload: z.looseObject({ n: z.number().optional() }) })
const AnsweredSchema = z.object({ channel: z.string(), args: z.array(z.string()), client: z.string(), correlationId: z.string() })

const hostEvent = (n: number): RuntimeEvent => ({ type: "machine-test", payload: JSON.stringify({ type: "machine-test", n }) })

/** The Thread's events from its stream that came from the host, decoded as a socket client decodes its lines. */
async function hostEvents(gateway: ReturnType<typeof createFakeGateway>, count: number) {
  const stream = (await gateway.connectClient(desktop)).subscribe({ stream: threadStream("th-1"), after: 0 })
  const seen: Array<z.infer<typeof HostEventLineSchema>> = []
  while (seen.length < count) {
    const line = HostEventLineSchema.safeParse((await stream.next(5_000)).event.decode())
    if (line.success) seen.push(line.data)
  }
  stream.close()
  return seen
}

test("the agent's link makes the host the machine's runtime: the Thread's operations reach its dispatcher, and its events reach the Thread in order, once, across a drop", async () => {
  const cloud = await machineGateway()
  const agent = machineAgent({ dataRoot: join(scratch, "one") })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await agent.until("enrolled", () => agent.state()?.link === "connected" && agent.state()?.enrolls === 1)
  assert.deepEqual(agent.links, [{ gatewayUrl: cloud.url, machine: "m-0123456789abcdef", credential: CREDENTIAL }], "the gateway's link given to what keeps its records and recipes in step")
  const generation = await cloud.gateway.assign("th-1", RUNTIME)
  agent.tell({ type: "inspect" })
  await agent.until("running the Thread", () => agent.state()?.threads[0]?.generation === generation)

  const [name, known] = [...hostOperations].find(([, call]) => call.replay === "read")!
  const session = await cloud.gateway.connectClient(desktop)
  const operation = toHostOperation(known.channel, hostCallInput(["a"], false), { id: crypto.randomUUID(), target: { kind: "thread", threadId: "th-1" }, actor: desktop, correlationId: "corr-machine-1", attempt: 1 })
  const answered = AnsweredSchema.parse(JSON.parse(hostReplyValue(await session.call(operation)) ?? "null"))
  assert.deepEqual(answered, { channel: known.channel, args: ["a"], client: "gateway:desktop:d-1", correlationId: "corr-machine-1" }, `${name} ran through the host's dispatcher`)

  agent.runtime.event("event", hostEvent(1))
  await agent.until("the first event acknowledged", () => agent.state()?.threads[0]?.waiting === 0 && agent.state()?.threads[0]?.acked === 1)
  cloud.drop()
  await agent.until("the drop noticed", () => agent.state()?.link !== "connected" || (agent.state()?.enrolls ?? 0) > 1, 30_000)
  agent.runtime.event("event", hostEvent(2))
  agent.runtime.event("terminal", hostEvent(3))
  await agent.until("enrolled again, and everything acknowledged", () => agent.state()?.enrolls === 2 && agent.state()?.threads[0]?.waiting === 0, 15_000)
  const events = await hostEvents(cloud.gateway, 3)
  assert.deepEqual(events.map((event) => [event.channel, event.payload.n]), [["event", 1], ["event", 2], ["terminal", 3]])
  assert.equal(agent.state()?.threads[0]?.lost, 0)

  // Too large for a gateway message: a live batch becomes the notice that its history changed; anything else is dropped and counted.
  const huge = "x".repeat(900_000)
  agent.runtime.event("event", { type: "live-batch", conversation: "c-1", payload: JSON.stringify({ type: "live-batch", batch: { id: "c-1", revision: 7, updates: [huge] } }) })
  agent.runtime.event("event", { type: "other", payload: JSON.stringify({ type: "other", huge }) })
  await agent.until("the notice acknowledged", () => agent.state()?.threads[0]?.acked === 4)
  const [notice] = (await hostEvents(cloud.gateway, 4)).slice(3)
  assert.deepEqual(notice?.payload, { type: "live-batch", batch: { id: "c-1", revision: 7, updates: [], historyChanged: true } })
  assert.deepEqual(agent.state()?.events, { emitted: 4, invalidated: 1, dropped: 1 })

  // A sampled batch's trace rides as its event's correlation ID, which the Thread logs and gives every reader.
  const reader = (await cloud.gateway.connectClient(desktop)).subscribe({ stream: threadStream("th-1"), after: 6 })
  // SAFETY: a batch as a live driver emits one, filled only as far as the machine runtime reads it (its trace).
  agent.runtime.event("event", encodeRuntimeEvent({ type: "live-batch", batch: { id: "c-1", revision: 25, updates: [], emittedAt: Date.now(), trace: "st-0f3a9c2e-71b4" } } as never))
  assert.equal((await reader.next(5_000)).correlationId, "st-0f3a9c2e-71b4")
  reader.close()

  // Silenced: the link closes and stays closed, and nothing more is sent for the Thread.
  agent.tell({ type: "unlink", reason: "this machine is a copy of another" })
  await agent.until("silent", () => agent.state()?.link === "silent")
  await agent.until("the connection closed", () => cloud.connected() === 0)
  const upgrades = cloud.upgrades()
  agent.runtime.event("event", hostEvent(5))
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  assert.equal(cloud.upgrades(), upgrades, "no connection attempted while silent")
  assert.equal(agent.state()?.unlinked, "this machine is a copy of another")
  assert.equal(agent.links.at(-1), null, "and taken back once silenced")
})

test("the machine tells its Thread when it works and when it stops, a silent turn included; host-wide readings stay off the Thread's stream", async () => {
  const cloud = await machineGateway()
  let work: LifecycleWork[] = []
  const item = (status: LifecycleWork["status"], title: string): LifecycleWork => ({ id: title, token: title, title, provider: "claude", cwd: "/w", status, stoppable: true })
  const agent = machineAgent({ dataRoot: join(scratch, "activity"), work: () => work })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await agent.until("enrolled", () => agent.state()?.link === "connected")
  await cloud.gateway.assign("th-1", RUNTIME)
  // Assigned, it says at once that nothing runs.
  await agent.until("idle said", () => cloud.gateway.activity("th-1")?.busy === false, 3_000)
  // A turn starts and streams nothing: busy all the same, within a tick.
  const started = Date.now()
  work = [item("running", "a long build")]
  await agent.until("busy said", () => cloud.gateway.activity("th-1")?.busy === true, 3_000)
  assert.ok(Date.now() - started < 1_500, "within a tick of the turn starting")
  assert.deepEqual(cloud.gateway.activity("th-1")?.work, ["claude running: a long build"])
  // Waiting on a person isn't work: a question survives a pause.
  work = [item("waiting", "an approval")]
  await agent.until("idle again", () => cloud.gateway.activity("th-1")?.busy === false, 3_000)
  // Readings about the machine's own harnesses never reach the Thread; the conversation's do.
  for (const type of ["account-usage", "harness-profile", "runtime-updates"]) agent.runtime.event("event", { type, payload: JSON.stringify({ type }) })
  agent.runtime.event("event", hostEvent(1))
  const [only] = await hostEvents(cloud.gateway, 1)
  assert.equal(only?.payload.n, 1)
  agent.tell({ type: "inspect" })
  await agent.until("one event counted, the readings not", () => agent.state()?.events.emitted === 1)
})

test("the machine reports the Sessions it owns on its link: everything at first, then what changed, never as a heartbeat, and everything again on a new link", async () => {
  const cloud = await machineGateway()
  const row = (state: ReportedSession["state"]): ReportedSession => ({ session: "0b8f3e1a-7c2d-4f6a-9e5b-1d3c8a7f2e60", thread: "6f1c9a52-0d4e-4b8e-9a51-3f2c7d1e8b40", conversation: "c-1", harness: "claude", title: "Retry the webhooks", state, createdAt: "2026-10-24T20:00:00.000Z", activityAt: "2026-10-24T20:00:00.000Z", generation: 1 })
  let rows: ReportedSession[] | undefined
  const sessions = new SessionPublisher({ rows: () => rows })
  const agent = machineAgent({ dataRoot: join(scratch, "sessions"), sessions })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await agent.until("enrolled", () => agent.state()?.link === "connected")
  // Before the host's core has loaded there's nothing to say.
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  assert.equal(cloud.gateway.reports(RUNTIME).length, 0)
  rows = [row("working")]
  await agent.until("everything said", () => cloud.gateway.reports(RUNTIME).length === 1, 3_000)
  assert.deepEqual(cloud.gateway.reports(RUNTIME)[0]?.owned, [{ session: row("working").session, generation: 1 }])
  // Unchanged across ticks and the second's throttle: nothing more.
  await new Promise((resolve) => setTimeout(resolve, 2_200))
  assert.equal(cloud.gateway.reports(RUNTIME).length, 1, "nothing again while nothing changed")
  rows = [row("idle")]
  sessions.changed()
  await agent.until("the change said", () => cloud.gateway.reports(RUNTIME).length === 2, 3_000)
  assert.equal(cloud.gateway.reports(RUNTIME)[1]?.listed[0]?.state, "idle")
  assert.equal(cloud.gateway.reports(RUNTIME)[1]?.owned, undefined, "a change, not everything")
  // A new link: everything again, since the gateway it reaches may not have heard it.
  cloud.drop()
  await agent.until("linked again and everything said again", () => cloud.gateway.reports(RUNTIME).at(-1)?.owned !== undefined && cloud.gateway.reports(RUNTIME).length === 3, 6_000)
})

/** A conversation's batch as its host emits it: whole, and compact against the answer it goes on with. */
function liveBatch(revision: number): Extract<HostEvent, { type: "live-batch" }> {
  const batch: LiveBatch = { id: "c-1", revision, updates: [{ kind: "text", id: "a", text: ` w${revision}` }] }
  return { type: "live-batch", batch, compact: compactLiveBatch(batch, { blocks: [{ type: "text", id: "a", text: "w" }], requests: [] }) }
}

const NoticeSchema = z.object({ streamNotice: z.string() }).loose()
const RevisionSchema = z.object({ batch: z.object({ revision: z.number() }).loose() }).loose()
/** The next batch a reader hears, by revision and the live form it came in, or the notice to read again in its place. */
async function nextBatch(reader: Subscription): Promise<{ revision: number; form: LiveForm } | { notice: string }> {
  for (;;) {
    const { text } = (await reader.next(5_000)).event
    const line = readEventLine(text)
    if (line?.type === "live-batch") return { revision: RevisionSchema.parse(JSON.parse(line.payload)).batch.revision, form: line.form }
    const notice = NoticeSchema.safeParse(JSON.parse(text))
    if (notice.success && notice.data.streamNotice === "reread") return { notice: "reread" }
  }
}

/** What the gateway said each time the form every reader reads changed. */
const formsSaid = (lines: GatewayLogLine[]) => lines.filter((line) => line.event === "live-form").map(({ form, readers, whole }) => ({ form, readers, whole }))

test("a Thread's batches go compact while every reader reads that form, and whole from the next one on while one doesn't", async () => {
  const lines: GatewayLogLine[] = []
  const cloud = await machineGateway(RUNTIME, { log: (line) => void lines.push(line) })
  const agent = machineAgent({ dataRoot: join(scratch, "forms") })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await agent.until("enrolled", () => agent.state()?.link === "connected")
  const generation = await cloud.gateway.assign("th-1", RUNTIME)
  const reads = (form: LiveForm) => agent.until(`the Thread's readers read form ${form}`, () => {
    agent.tell({ type: "inspect" })
    return agent.state()?.threads[0]?.generation === generation && agent.state()?.threads[0]?.form === form
  })
  const reader = (live?: LiveForm) => cloud.gateway.connectClient(desktop, live ? { live } : {}).then((session) => session.subscribe({ stream: threadStream("th-1"), after: Number.MAX_SAFE_INTEGER }))

  const compact = await reader(LIVE_FORM)
  await reads(LIVE_FORM)
  agent.runtime.event("event", encodeRuntimeEvent(liveBatch(1)))
  assert.deepEqual(await nextBatch(compact), { revision: 1, form: LIVE_FORM }, "compact while its one reader reads it")
  // A reader of an older build comes: from the next batch on, whole for both.
  const whole = await reader()
  await reads(WHOLE_LIVE_FORM)
  agent.runtime.event("event", encodeRuntimeEvent(liveBatch(2)))
  assert.deepEqual(await nextBatch(compact), { revision: 2, form: WHOLE_LIVE_FORM })
  assert.deepEqual(await nextBatch(whole), { revision: 2, form: WHOLE_LIVE_FORM })
  // And goes: compact again, with nothing missed or heard twice by the reader that stayed.
  whole.close()
  await reads(LIVE_FORM)
  agent.runtime.event("event", encodeRuntimeEvent(liveBatch(3)))
  assert.deepEqual(await nextBatch(compact), { revision: 3, form: LIVE_FORM })
  // Read by nobody, it goes whole: whoever reads it next may read no other.
  compact.close()
  assert.deepEqual(formsSaid(lines), [{ form: 2, readers: 1, whole: 0 }, { form: 1, readers: 2, whole: 1 }, { form: 2, readers: 1, whole: 0 }, { form: 1, readers: 0, whole: 0 }], "each change logged with its readers")
  agent.tell({ type: "inspect" })
  await agent.until("the compact frames counted", () => agent.state()?.threads[0]?.compact === 2)
})

test("a watched conversation's updates go compact while every watcher reads that form, and whole from the next one on while one doesn't", async () => {
  const lines: GatewayLogLine[] = []
  const cloud = await machineGateway(RUNTIME, { log: (line) => void lines.push(line) })
  const sessions = new SessionPublisher({ rows: () => undefined })
  const agent = machineAgent({ dataRoot: join(scratch, "watch-forms"), sessions })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await agent.until("enrolled", () => agent.state()?.link === "connected")
  const watcher = (live?: LiveForm) => cloud.gateway.connectClient(desktop, live ? { live } : {}).then((session) => session.subscribe({ stream: sessionStream(RUNTIME, "c-1"), after: 0 }))
  const reads = (compact: number) => agent.until(`${compact} conversation watched compact`, () => sessions.readings().watched === 1 && sessions.readings().compact === compact)

  const compact = await watcher(LIVE_FORM)
  await reads(1)
  assert.equal(sessions.readings().negotiated, true)
  sessions.own(liveBatch(1))
  assert.deepEqual(await nextBatch(compact), { revision: 1, form: LIVE_FORM }, "compact while its one watcher reads it")
  const whole = await watcher()
  await reads(0)
  sessions.own(liveBatch(2))
  assert.deepEqual(await nextBatch(compact), { revision: 2, form: WHOLE_LIVE_FORM })
  assert.deepEqual(await nextBatch(whole), { revision: 2, form: WHOLE_LIVE_FORM })
  whole.close()
  await reads(1)
  sessions.own(liveBatch(3))
  assert.deepEqual(await nextBatch(compact), { revision: 3, form: LIVE_FORM })
  compact.close()
  assert.deepEqual(formsSaid(lines), [{ form: 2, readers: 1, whole: 0 }, { form: 1, readers: 2, whole: 1 }, { form: 2, readers: 1, whole: 0 }], "each change logged with its watchers")
})

test("a change a list shows on the machine goes out at once, not at its next tick", async () => {
  const cloud = await machineGateway()
  const row = (state: ReportedSession["state"]): ReportedSession => ({ session: "0b8f3e1a-7c2d-4f6a-9e5b-1d3c8a7f2e60", thread: "6f1c9a52-0d4e-4b8e-9a51-3f2c7d1e8b40", conversation: "c-1", harness: "claude", state, createdAt: "2026-10-24T20:00:00.000Z", activityAt: "2026-10-24T20:00:00.000Z", generation: 1 })
  let rows: ReportedSession[] | undefined
  let shown: ReportedSession["state"] = "working"
  // As composition makes it on a cloud machine: the early report goes on the machine's own link.
  let runtime: MachineRuntime | undefined
  const sessions = new SessionPublisher({ rows: () => rows, shown: () => ({ state: shown }), reportNow: () => runtime?.reportSessions() })
  const agent = machineAgent({ dataRoot: join(scratch, "sessions-early"), sessions })
  runtime = agent.runtime
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await agent.until("enrolled", () => agent.state()?.link === "connected")
  rows = [row("working")]
  await agent.until("everything said, at a tick", () => cloud.gateway.reports(RUNTIME).length === 1, 3_000)
  // SAFETY: a host event as a live driver emits one, filled only as far as the publisher reads it.
  sessions.own({ type: "live-batch", batch: { id: "c-1", revision: 2, updates: [] } } as never)
  // The turn ends just after that tick: the next is a second away.
  rows = [row("idle")]
  shown = "idle"
  const changed = Date.now()
  // SAFETY: as above, a host event filled only as far as the publisher reads it.
  sessions.own({ type: "live-batch", batch: { id: "c-1", revision: 3, updates: [] } } as never)
  await agent.until("the change said", () => cloud.gateway.reports(RUNTIME).length === 2, 3_000)
  const ms = Date.now() - changed
  assert.equal(cloud.gateway.reports(RUNTIME)[1]?.listed[0]?.state, "idle")
  assert.ok(ms < 400, `said ${ms} ms after it changed`)
})

test("a machine that woke keeps a connection that survived its pause, and replaces one that didn't, within a second and a half", async () => {
  const cloud = await machineGateway()
  const agent = machineAgent({ dataRoot: join(scratch, "woke") })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await agent.until("enrolled", () => agent.state()?.link === "connected" && agent.state()?.enrolls === 1)
  // It survived: the ping is answered, and the connection the gateway may be sending on stays.
  const upgrades = cloud.upgrades()
  agent.tell({ type: "wake" })
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  assert.equal(cloud.upgrades(), upgrades, "no new connection for one that answered")
  assert.equal(agent.state()?.enrolls, 1)
  // It didn't: nothing answers, and a new connection replaces it once the probe runs out, without a backoff.
  cloud.silence()
  const woke = Date.now()
  agent.tell({ type: "wake" })
  await agent.until("enrolled on it", () => agent.state()?.link === "connected" && agent.state()?.enrolls === 2, 3_000)
  const replacedMs = Date.now() - woke
  assert.ok(replacedMs >= 1_400 && replacedMs < 2_800, `replaced after ${replacedMs} ms`)
})

test("a credential the agent renewed keeps the connection, and the next connection and the records carry it", async () => {
  const cloud = await machineGateway()
  const agent = machineAgent({ dataRoot: join(scratch, "renewed") })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  const link = { type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 } as const
  agent.tell(link)
  await agent.until("enrolled", () => agent.state()?.link === "connected" && agent.state()?.enrolls === 1)
  const renewed = `mmc_${"r".repeat(43)}`
  cloud.accepted.add(renewed)
  const upgrades = cloud.upgrades()
  agent.tell({ ...link, credential: renewed })
  await agent.until("the records given the renewed credential", () => agent.links.at(-1)?.credential === renewed)
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(cloud.upgrades(), upgrades, "the connection goes on")
  assert.equal(agent.state()?.enrolls, 1)
  // The old credential is retired: the next connection must carry the renewed one.
  cloud.accepted.delete(CREDENTIAL)
  cloud.drop()
  await agent.until("enrolled again on the renewed credential", () => agent.state()?.link === "connected" && agent.state()?.enrolls === 2, 15_000)
})

test("the sign-ins the agent gives are installed one set at a time, the newest last, and what became of each is in the runtime's state", async () => {
  const agent = machineAgent({ dataRoot: await mkdtemp(join(tmpdir(), "mako-machine-sign-ins-")) })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello" && message.protocol >= 2))
  const signIn = (harness: "claude" | "codex" | "grok") => ({ harness, label: null, expiresAt: null, payload: { key: harness } })
  agent.tell({ type: "sign-ins", secrets: "/run/mako/secrets/host", signIns: [signIn("claude")] })
  agent.tell({ type: "sign-ins", secrets: "/run/mako/secrets/host", signIns: [signIn("codex")] })
  agent.tell({ type: "sign-ins", secrets: "/run/mako/secrets/host", signIns: [signIn("claude"), signIn("codex"), signIn("grok")] })
  await agent.until("the newest set installed", () => agent.state()?.signIns.length === 3)
  assert.deepEqual(agent.installs.map((install) => install.harnesses.join(",")), ["claude", "claude,codex,grok"], "a set replaced before its turn is never installed")
  assert.deepEqual(agent.state()?.signIns.map((install) => `${install.harness}:${install.status}`), ["claude:installed", "codex:installed", "grok:failed"])
  agent.tellRaw(JSON.stringify({ type: "sign-ins", secrets: "relative", signIns: [] }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(agent.installs.length, 2, "a folder that isn't absolute is refused")
})

test("the workspace the agent gives opens once however often it's given, and one that failed is tried again", async () => {
  const agent = machineAgent({ dataRoot: await mkdtemp(join(tmpdir(), "mako-machine-workspace-")) })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello" && message.protocol >= 3))
  const opens = () => agent.workspaces.length
  agent.tell({ type: "workspace", path: "/home/node/work/missing" })
  await agent.until("the failure reported", () => agent.state()?.workspace?.status === "failed")
  assert.equal(agent.state()?.workspace?.reason, "no such folder")
  agent.tell({ type: "workspace", path: "/home/node/work/missing" })
  await agent.until("tried again", () => opens() === 2)
  agent.tell({ type: "workspace", path: "/home/node/work/repo" })
  agent.tell({ type: "workspace", path: "/home/node/work/repo" })
  await agent.until("the workspace opened", () => agent.state()?.workspace?.status === "opened" && agent.state()?.workspace?.path === "/home/node/work/repo")
  agent.tell({ type: "workspace", path: "/home/node/work/repo" })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(opens(), 3, "the workspace already open isn't opened again")
  agent.tellRaw(JSON.stringify({ type: "workspace", path: "relative" }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(opens(), 3, "a folder that isn't absolute is refused")
})

test("the carried files the agent placed reach the host by name, and a move's arrival asks for them again and waits for the answer", async () => {
  const agent = machineAgent({ dataRoot: await mkdtemp(join(tmpdir(), "mako-machine-carried-")) })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello" && message.protocol >= 7))
  agent.tell({ type: "carried-files", files: [{ path: ".env", names: ["SHOP_TOKEN"] }] })
  await agent.until("the names given to the host", () => agent.carried.length === 1)
  assert.deepEqual(agent.carried[0], ["SHOP_TOKEN"])

  const asked = agent.runtime.refreshCarried()
  await agent.until("the agent asked", () => agent.messages.some((message) => message.type === "carried-files-refresh"))
  const request = agent.messages.findLast((message) => message.type === "carried-files-refresh")
  assert.ok(request?.type === "carried-files-refresh")
  // Another placing's answer isn't this one's.
  agent.tell({ type: "carried-files", files: [], answers: "someone-else" })
  agent.tell({ type: "carried-files", files: [{ path: ".env", names: ["SHOP_TOKEN", "NEW_KEY"] }], answers: request.id })
  assert.deepEqual(await asked, { files: [{ path: ".env", names: ["SHOP_TOKEN", "NEW_KEY"] }] })
  assert.deepEqual(agent.carried.at(-1), ["SHOP_TOKEN", "NEW_KEY"])
  await agent.until("the state says what's placed", () => {
    agent.tell({ type: "inspect" })
    return agent.state()?.carried?.files.length === 1
  })

  const failing = agent.runtime.refreshCarried()
  await agent.until("asked again", () => agent.messages.filter((message) => message.type === "carried-files-refresh").length === 2)
  const second = agent.messages.findLast((message) => message.type === "carried-files-refresh")
  assert.ok(second?.type === "carried-files-refresh")
  agent.tell({ type: "carried-files", files: [], problem: "the gateway answered 503", answers: second.id })
  assert.deepEqual(await failing, { files: [], problem: "the gateway answered 503" })
})

test("before a pull request the host asks the agent whether it goes as the person, and an unanswered ask is unknown, never off", async () => {
  const agent = machineAgent({ dataRoot: await mkdtemp(join(tmpdir(), "mako-machine-person-")) })
  const asked = agent.runtime.githubPerson()
  await agent.until("the agent asked", () => agent.messages.some((message) => message.type === "github-person-refresh"))
  const request = agent.messages.findLast((message) => message.type === "github-person-refresh")
  assert.ok(request?.type === "github-person-refresh")
  agent.tell({ type: "github-person", answers: "someone-else", person: { state: "off" } })
  agent.tell({ type: "github-person", answers: request.id, person: { state: "on", login: "ada", expiresAt: null } })
  assert.deepEqual(await asked, { state: "on", login: "ada", expiresAt: null })
  // A token in the answer isn't the protocol's: the message is refused whole, so the ask isn't answered by it.
  const again = agent.runtime.githubPerson()
  await agent.until("asked again", () => agent.messages.filter((message) => message.type === "github-person-refresh").length === 2)
  const second = agent.messages.findLast((message) => message.type === "github-person-refresh")
  assert.ok(second?.type === "github-person-refresh")
  agent.tellRaw(JSON.stringify({ type: "github-person", answers: second.id, person: { state: "on", login: "ada", expiresAt: null, token: "github_pat_madeUpForTests0123456789" } }))
  agent.tell({ type: "github-person", answers: second.id, person: { state: "unusable", problem: "Mako Cloud couldn't open your GitHub token." } })
  assert.deepEqual(await again, { state: "unusable", problem: "Mako Cloud couldn't open your GitHub token." })
  agent.runtime.stop()
  assert.equal((await agent.runtime.githubPerson()).state, "unknown", "a runtime that can't ask says unknown")
})

test("a base's folder is prepared when the agent asks, and the host says so either way", async () => {
  const agent = machineAgent({ dataRoot: await mkdtemp(join(tmpdir(), "mako-machine-prepare-")) })
  agent.tell({ type: "prepare", path: "/home/node/work/repo" })
  await agent.until("prepared", () => agent.messages.some((message) => message.type === "prepared" && message.path === "/home/node/work/repo"))
  const done = agent.messages.find((message) => message.type === "prepared" && message.path === "/home/node/work/repo")
  assert.equal(done?.type === "prepared" && done.ok, true)
  agent.tell({ type: "prepare", path: "/home/node/work/missing" })
  await agent.until("the failure answered", () => agent.messages.some((message) => message.type === "prepared" && message.path === "/home/node/work/missing"))
  const failed = agent.messages.find((message) => message.type === "prepared" && message.path === "/home/node/work/missing")
  assert.equal(failed?.type === "prepared" && failed.ok, false, "a folder that failed is answered, so the base isn't held")
  assert.deepEqual(agent.prepared, ["/home/node/work/repo", "/home/node/work/missing"])
  assert.equal(agent.workspaces.length, 0, "preparing a folder opens no workspace")
})

test("the harness a machine boots for has its start run ahead, said in the host's own log", async () => {
  const agent = machineAgent({ dataRoot: await mkdtemp(join(tmpdir(), "mako-machine-prefetch-")) })
  agent.tell({ type: "prefetch", harness: "codex" })
  await agent.until("the start run ahead", () => agent.messages.some((message) => message.type === "log" && message.message === "a start was run ahead"))
  const said = agent.messages.find((message) => message.type === "log" && message.message === "a start was run ahead")
  assert.deepEqual(said?.type === "log" && said.fields, { harness: "codex", ms: 12, answered: true, stopped: false, readMiB: 230, readMs: 800 })
  agent.tellRaw(JSON.stringify({ type: "prefetch", harness: "Not A Harness" }))
  agent.tell({ type: "prefetch", harness: "none" })
  await agent.until("the second asked", () => agent.prefetched.length === 2)
  assert.deepEqual(agent.prefetched, ["codex", "none"], "a name no harness could have is refused before it's asked")
})

test("the start run ahead goes on to its signed-in stage once that harness's sign-in is installed, whichever comes first", async () => {
  const signIn = (harness: "claude" | "codex" | "grok") => ({ harness, label: null, expiresAt: null, payload: { key: harness } })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60))
  const first = machineAgent({ dataRoot: await mkdtemp(join(tmpdir(), "mako-machine-signed-in-")) })
  first.tell({ type: "prefetch", harness: "codex" })
  await first.until("the start run ahead", () => first.prefetched.length === 1)
  await settle()
  assert.deepEqual(first.signedIn, [], "nothing signed in is asked before the sign-in is there")
  first.tell({ type: "sign-ins", secrets: "/run/mako/secrets/host", signIns: [signIn("claude"), signIn("codex")] })
  await first.until("the signed-in stage asked", () => first.signedIn.length === 1)
  assert.deepEqual(first.signedIn, ["codex"])
  await first.until("its line", () => first.messages.some((message) => message.type === "log" && message.message === "a start's sign-in stage was run ahead"))
  first.tell({ type: "sign-ins", secrets: "/run/mako/secrets/host", signIns: [signIn("codex")] })
  await first.until("the stage asked again for the new sign-in", () => first.signedIn.length === 2)

  const second = machineAgent({ dataRoot: await mkdtemp(join(tmpdir(), "mako-machine-signed-in-")) })
  second.tell({ type: "sign-ins", secrets: "/run/mako/secrets/host", signIns: [signIn("grok"), signIn("claude")] })
  await second.until("installed", () => second.state()?.signIns.length === 2)
  second.tell({ type: "prefetch", harness: "grok" })
  await second.until("the start run ahead", () => second.prefetched.length === 1)
  await settle()
  assert.deepEqual(second.signedIn, [], "a sign-in that failed to install isn't asked with")
  second.tell({ type: "prefetch", harness: "claude" })
  await second.until("the signed-in stage asked", () => second.signedIn.length === 1)
  assert.deepEqual(second.signedIn, ["claude"], "a sign-in installed before the hint is asked with at the hint")
})

test("each harness launch says what used the machine's CPU while it ran, the busiest first", async () => {
  const samples: CpuSample[] = [
    { at: 0, busy: 1_000, byName: new Map([["devin", 50], ["node:host-main.js", 400], ["git", 10]]), threads: new Map([["MainThread", 300], ["V8Worker", 100]]) },
    { at: 1_200, busy: 1_190, byName: new Map([["devin", 111], ["node:host-main.js", 440], ["git", 32], ["sleep", 1]]), threads: new Map([["MainThread", 330], ["V8Worker", 110]]) },
  ]
  const agent = machineAgent({ dataRoot: await mkdtemp(join(tmpdir(), "mako-machine-cpu-")), sampleCpu: async () => samples.shift() })
  hostLog("provider-startup", "phase", { provider: "devin", conversation: "0123456789abcdef", attempt: "a1", phase: "launch", state: "started" })
  hostLog("provider-startup", "phase", { provider: "devin", conversation: "0123456789abcdef", attempt: "a1", phase: "launch", state: "done", durationMs: 1200 })
  await agent.until("the launch's CPU", () => agent.messages.some((message) => message.type === "log" && message.message === "cpu while a harness started"))
  const said = agent.messages.find((message) => message.type === "log" && message.message === "cpu while a harness started")
  assert.deepEqual(said?.type === "log" && said.fields, { harness: "devin", conversation: "01234567", cpu: "1.90 s busy in 1.20 s: devin 0.61 s, node:host-main.js 0.40 s, git 0.22 s, sleep 0.01 s, ended or kernel 0.66 s", threads: "MainThread 0.30 s, V8Worker 0.10 s" })
  assert.equal(cpuBetween(samples[0] ?? { at: 0, busy: 0, byName: new Map(), threads: new Map() }, { at: 10, busy: 0, byName: new Map(), threads: new Map() }).busy, 0, "a counter that went back counts nothing")
})

test("the host's own CPU over a window is taken apart by the file that spent it", async () => {
  const profiler = new HostProfiler()
  assert.equal(await profiler.start(), true)
  assert.equal(await profiler.start(), false, "one window at a time")
  const until = performance.now() + 300
  let spun = 0
  while (performance.now() < until) spun += Math.sqrt(spun + 1)
  const files = await profiler.stop()
  assert.ok(spun > 0)
  assert.ok(files?.some((entry) => entry.file.endsWith("test-machine-runtime.ts") && entry.seconds >= 0.15), `the busy file first: ${JSON.stringify(files)}`)
  assert.equal(await profiler.stop(), undefined, "a window stops once")
})

test("a start's lines go to the agent for its timeline: phases as they end, the machine's own, warnings; nothing else", async () => {
  const agent = machineAgent({ dataRoot: await mkdtemp(join(tmpdir(), "mako-machine-timeline-")) })
  hostLog("provider-startup", "phase", { provider: "codex", phase: "handshake", state: "started" })
  hostLog("provider-startup", "phase", { provider: "codex", phase: "handshake", state: "done", durationMs: 812 })
  hostLog("threads", "catalog placed in Threads", { rows: 0 })
  hostWarn("discovery", "a model was refused", { model: "x".repeat(400) })
  hostLog("machine", "the clock jumped", { gapMs: 1000 })
  const emitted = new Set(["phase", "catalog placed in Threads", "a model was refused", "the clock jumped"])
  const ours = () => agent.messages.filter((message) => message.type === "log" && emitted.has(message.message))
  await agent.until("three lines", () => ours().length >= 3)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const lines = ours().flatMap((message) => message.type === "log" ? [`${message.level} ${message.scope} ${message.message} ${message.fields?.state ?? ""}`.trim()] : [])
  assert.deepEqual(lines, ["info provider-startup phase done", "warn discovery a model was refused", "info machine the clock jumped"])
  const warned = agent.messages.find((message) => message.type === "log" && message.level === "warn")
  assert.equal(warned?.type === "log" && String(warned.fields?.model).length, 301, "a long field is cut for the agent's log")
})

test("a link given while the workspace opens waits for it, so the Thread's first call runs in the workspace", async () => {
  const cloud = await machineGateway()
  const agent = machineAgent({ dataRoot: join(scratch, "workspace-first") })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  agent.tell({ type: "workspace", path: "/home/node/work/slow" })
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(cloud.upgrades(), 0, "no connection while the workspace opens")
  await agent.until("connected", () => agent.state()?.link === "connected", 5_000)
  const states = agent.messages.flatMap((message) => (message.type === "state" ? [message.state] : []))
  const opened = states.findIndex((state) => state.workspace?.status === "opened")
  const linking = states.findIndex((state) => state.link !== "none")
  assert.ok(opened >= 0 && opened < linking, `the workspace opened (state ${opened}) before the link began (state ${linking})`)
})

test("a clock that jumps is told to the agent within a second, and counted in the runtime's state", async () => {
  let offset = 0
  const agent = machineAgent({ dataRoot: join(scratch, "two"), now: () => Date.now() + offset })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  offset += 30_000
  await agent.until("the jump reported", () => agent.messages.some((message) => message.type === "resumed"), 3_000)
  const resumed = agent.messages.find((message) => message.type === "resumed")
  assert.ok(resumed?.type === "resumed" && resumed.gapMs >= 29_000, JSON.stringify(resumed))
  await agent.until("counted in its state", () => agent.state()?.resumes === 1)
})

test("a host that restarts numbers its Thread's events after what it reserved, so none is taken for a repeat", async () => {
  const cloud = await machineGateway()
  const dataRoot = join(scratch, "three")
  const first = machineAgent({ dataRoot })
  first.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await first.until("enrolled", () => first.state()?.link === "connected")
  const generation = await cloud.gateway.assign("th-1", RUNTIME)
  first.tell({ type: "inspect" })
  await first.until("running the Thread", () => first.state()?.threads[0]?.generation === generation)
  first.runtime.event("event", hostEvent(1))
  await first.until("acknowledged", () => first.state()?.threads[0]?.acked === 1)
  first.runtime.stop()
  cloud.drop()

  // The same machine's host, started again: it claims nothing, and the gateway gives it the Thread under the same generation.
  const second = machineAgent({ dataRoot })
  second.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await second.until("enrolled", () => second.state()?.link === "connected")
  second.tell({ type: "inspect" })
  await second.until("running the Thread again", () => second.state()?.threads[0]?.generation === generation)
  second.runtime.event("event", hostEvent(2))
  await second.until("acknowledged", () => second.state()?.threads[0]?.acked === 1)
  assert.ok((second.state()?.threads[0]?.localSeq ?? 0) > 1_000, `numbered ${second.state()?.threads[0]?.localSeq}, after the reserved block`)
  const events = await hostEvents(cloud.gateway, 2)
  assert.deepEqual(events.map((event) => event.payload.n), [1, 2], "the restarted host's event is recorded, not taken for the first")
})

test("an unknown or malformed message from the agent is ignored, and a credential that's refused isn't retried in a hot loop", async () => {
  const cloud = await machineGateway()
  const agent = machineAgent({ dataRoot: join(scratch, "four") })
  agent.tellRaw(JSON.stringify({ type: "launch-missiles" }))
  agent.tellRaw(JSON.stringify({ type: "link", gatewayUrl: "ftp://nope", runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m", generation: 1 }))
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: `mmc_${"w".repeat(43)}`, machine: "m-0123456789abcdef", generation: 1 })
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  // Node's WebSocket asks twice for an upgrade the server refuses, so attempts are counted by the requests' spacing.
  const attempts = cloud.attempts()
  assert.ok(attempts.length >= 2 && attempts.length <= 4, `${attempts.length} attempts in 2.5 s, with backoff: ${attempts.join(", ")} ms`)
  // The backoff's first step is a quarter second, jittered down to a fifth at least; the next a second.
  assert.ok(attempts.every((at, index) => index === 0 || at - attempts[index - 1]! >= 190), `spaced by the backoff: ${attempts.join(", ")} ms`)
  assert.notEqual(agent.state()?.link, "connected")
})

test("a machine made for a lost one restores its Thread's save before its runtime speaks, trying again until it has; a Thread's first machine asks nothing", async () => {
  const replacement = "m-0123456789abcdef.g2"
  const cloud = await machineGateway(replacement)
  let tries = 0
  let release: (() => void) | undefined
  const asked: Array<{ machine: string; generation: number }> = []
  const agent = machineAgent({
    dataRoot: join(scratch, "restore"),
    restore: async (link, generation) => {
      asked.push({ machine: link.machine, generation })
      tries += 1
      if (tries === 1) throw new Error("the checkpoint couldn't be read")
      await new Promise<void>((resolve) => (release = resolve))
      return { from: 1, ms: 1_234 }
    },
  })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: replacement, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 2 })
  await agent.until("restoring, once tried again", () => tries === 2 && release !== undefined, 5_000)
  assert.equal(agent.links.length, 1, "the records' link given first, which the restore reads")
  agent.tell({ type: "inspect" })
  await agent.until("restoring said", () => agent.state()?.restore?.state === "restoring" && agent.state()?.restore?.attempts === 2)
  assert.match(agent.state()?.restore?.failed ?? "", /checkpoint couldn't be read/)
  assert.equal(cloud.upgrades(), 0, "silent while it restores: the Thread's first message would find nothing as it was")
  release?.()
  await agent.until("connected once restored", () => agent.state()?.link === "connected")
  assert.deepEqual(agent.state()?.restore && { state: agent.state()?.restore?.state, from: agent.state()?.restore?.from }, { state: "restored", from: 1 })
  assert.deepEqual(asked, [{ machine: "m-0123456789abcdef", generation: 2 }, { machine: "m-0123456789abcdef", generation: 2 }])
  assert.equal(agent.links.length, 1, "given once, not again as it connects")

  // A Thread's first machine has nothing before it to restore: it connects at once, asking nothing.
  const first = await machineGateway()
  let firstAsked = 0
  const fresh = machineAgent({ dataRoot: join(scratch, "restore-first"), restore: async () => ((firstAsked += 1), undefined) })
  await fresh.until("the host's hello", () => fresh.messages.some((message) => message.type === "hello"))
  fresh.tell({ type: "link", gatewayUrl: first.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await fresh.until("connected", () => fresh.state()?.link === "connected")
  assert.equal(firstAsked, 0)
})

test("a machine says it's idle only once its turn's save has landed, so idle means saved", async () => {
  const cloud = await machineGateway()
  let work: LifecycleWork[] = [{ id: "t", token: "t", title: "a turn", provider: "claude", cwd: "/w", status: "running", stoppable: true }]
  const busy: boolean[] = []
  let land: (() => void) | undefined
  const settles: string[] = []
  const agent = machineAgent({
    dataRoot: join(scratch, "idle-saved"),
    work: () => work,
    saves: {
      working: (now) => void busy.push(now),
      settle: (why) => {
        settles.push(why)
        return new Promise<void>((resolve) => (land = resolve))
      },
    },
  })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await agent.until("enrolled", () => agent.state()?.link === "connected")
  await cloud.gateway.assign("th-1", RUNTIME)
  await agent.until("busy said", () => cloud.gateway.activity("th-1")?.busy === true, 3_000)
  assert.ok(busy.includes(true), "the tracker hears it works")
  work = []
  await agent.until("the turn's save asked for", () => settles.length === 1, 3_000)
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  assert.equal(cloud.gateway.activity("th-1")?.busy, true, "still busy while the save is on its way")
  land?.()
  await agent.until("idle once saved", () => cloud.gateway.activity("th-1")?.busy === false, 3_000)
  assert.deepEqual(settles, ["a turn ended"], "one save per turn's end")
})

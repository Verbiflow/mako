import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs } from "node:util"
import { z } from "zod"
import type { Actor, Json, ServedRuntime } from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { gatewayHostCalls, sendWithRepeats } from "@mako/host/contracts/gateway-host-calls"
import { hostCallSchema } from "@mako/host/contracts/host-call-inputs"
import { RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { decodeRuntimeValue, encodeRuntimeValue, type EncodedValue } from "@mako/host/contracts/runtime-value"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { assessProviderResume } from "@mako/host/harnesses/provider-recovery"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

/**
 * Messages sent to one Session from several clients at nearly the same moment: `npm run test:send-race`.
 *
 * One conversation host (`LiveConversations`, its driver a stand-in harness whose turns and steers take a few random
 * milliseconds) is reached the ways a person reaches it: the Mac's own window on the socket, and a phone and another
 * Mac through a gateway (the protocol's fake, with the host's own `serveHostThroughGateway` and the clients' own
 * `gatewayHostCalls` and `sendWithRepeats`). Each run starts a conversation and has those clients send a burst of
 * messages at random small offsets, steering where a turn runs, while the run may cut the Mac's link to the gateway
 * mid-send, lose a reply so the client asks again under the same ID, have the Mac take a message that waited in the
 * account twice at once (`CloudConversations.#takeWaiting` hearing the list twice), or restart the host. Every send
 * resolves its settings for a random few milliseconds first, as `HarnessProfiles.resolveLaunch` does on real I/O.
 *
 * After each run, and a last message sent once everything settled, it holds:
 * 1. Exactly once: every message the person sent reached the harness once (as a turn or a steer), refused ones were
 *    sent again by the person and so also once, and no request ID is held twice.
 * 2. One serialization point: the harness never ran two turns at once, and turns ran in the order the host admitted
 *    their messages, which is the order the messages arrived at it.
 * 4. Nothing stuck: no message is left queued or sending, the session is idle, and it takes the next message.
 *
 *   npm run test:send-race [-- --runs <n>] [--seed <n>]
 */
const { values } = parseArgs({ options: { runs: { type: "string", default: "150" }, seed: { type: "string" } } })
const RUNS = Number(values.runs)
const SEED = values.seed === undefined ? Math.floor(Math.random() * 2 ** 31) : Number(values.seed)

/** A small seeded generator (mulberry32), so a failing run is repeated with its seed. */
function generator(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (max: number) => Math.floor(next() * (max + 1)), chance: (p: number) => next() < p }
}
const random = generator(SEED)

const root = mkdtempSync(join(tmpdir(), "mako-send-race-"))
const CWD = root

/* ---------------------------------------------------------- the harness */

/** What the stand-in harness was given, in order: each turn's request and each steer, by ID. */
type Heard = { kind: "turn" | "steer"; id: string; text: string }
const heard: Heard[] = []
/** While set, each turn runs until the case ends it (`held`). */
let holding = false
const held: Array<() => void> = []
/** Turns running now, by conversation: never more than one. */
const turning = new Map<string, number>()
let overlaps = 0

function harness(owner: () => LiveConversations): ProviderLiveDriver {
  const sessions = new Map<string, LiveSessionState>()
  const end = (id: string) => {
    const session = sessions.get(id)
    if (!session || session.status !== "running") return
    turning.set(id, (turning.get(id) ?? 1) - 1)
    const ready: LiveSessionState = { ...session, status: "ready", nativeRunId: undefined }
    sessions.set(id, ready)
    owner().observe({ type: "live-session", session: ready })
  }
  return {
    ...noCapabilities,
    resume: fixtureResume({ checkpoint: async () => "checkpoint", inspect: async () => ({ kind: "available", checkpoint: "checkpoint", strategy: "same-session" }) }),
    steering: {
      kind: "supported",
      lands: "step",
      via: "Injected driver fixture",
      steer: async (id, input) => {
        await delay(random.int(4))
        const session = sessions.get(id)
        if (session?.status !== "running" || session.nativeRunId !== input.expectedRunId) return { kind: "not-accepted", reason: "The turn ended" }
        heard.push({ kind: "steer", id: input.id, text: input.text })
        return { kind: "accepted" }
      },
    },
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider: "race",
    available: () => true,
    async start(cwd, options) {
      const session: LiveSessionState = {
        id: options.conversationId,
        nativeId: options.resume ?? `native-${options.conversationId}`,
        // As every real driver does: a resumed session names the source it reopened.
        nativePath: options.resume ? options.threadPath : undefined,
        harness: "race",
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
    async prompt(id, text, _attachments, _settings, dispatch) {
      const running = turning.get(id) ?? 0
      if (running) overlaps++
      turning.set(id, running + 1)
      dispatch.report({ kind: "submitted", source: "transport-call" })
      heard.push({ kind: "turn", id: dispatch.operationId, text })
      const session: LiveSessionState = { ...sessions.get(id)!, status: "running", nativeRunId: randomUUID() }
      sessions.set(id, session)
      owner().observe({ type: "live-session", session })
      if (holding) held.push(() => end(id))
      else setTimeout(() => end(id), random.int(12))
    },
    async permission() {},
    async cancel(id) {
      end(id)
    },
    async setMode() {},
    close(id) {
      const session = sessions.get(id)
      if (session?.status === "running") turning.set(id, (turning.get(id) ?? 1) - 1)
      sessions.delete(id)
    },
  }
}

/* ---------------------------------------------------------- the host and its three ways in */

const journals = join(root, "journals")
let owner!: LiveConversations
const driver = harness(() => owner)
const openHost = () => new LiveConversations({
  root: journals,
  appPath: root,
  driver: () => driver,
  history: async () => null,
  emit: () => {},
  nativePath: (session) => (session.nativeId ? join(root, "native", `${session.nativeId}.jsonl`) : undefined),
  checkpoint: async () => "checkpoint",
  resumeVerdict: (binding) => assessProviderResume(binding, driver),
})
owner = openHost()

/**
 * Each message's first arrival at each host life, in order, and which life first admitted it: the order a host must
 * admit messages in is the order they arrived at it. One refused as a host stopped arrives again at the next.
 */
const arrivals = new Map<LiveConversations, string[]>()
const admittedBy = new Map<string, LiveConversations>()

/**
 * The host's methods these clients call, as `declareConversationMethods` declares them: a message resolves its
 * settings (here a few random milliseconds, as `resolveLaunch`'s real path and environment reads take) and is admitted
 * in the order it arrived.
 */
async function invoke(channel: string, args: unknown[]): Promise<EncodedValue> {
  const host = owner
  if (channel === "mako:live-prompt") {
    const [id, requestId, text] = hostCallSchema("mako:live-prompt").parse(args)
    const arrived = arrivals.get(host) ?? []
    if (!arrived.includes(requestId)) arrivals.set(host, [...arrived, requestId])
    if (!host.session(id)) throw new Error("This conversation is no longer available")
    const resolving = delay(random.int(6)).then(() => undefined)
    const request = await host.admitInOrder(id, resolving, (tuning) => host.submit(id, requestId, text, [], tuning))
    if (!admittedBy.has(requestId)) admittedBy.set(requestId, host)
    return encodeRuntimeValue(request)
  }
  if (channel === "mako:live-action") {
    const [id, input] = hostCallSchema("mako:live-action").parse(args)
    return encodeRuntimeValue(await host.act(id, input))
  }
  if (channel === "mako:live-edit-queued") {
    const [id, edit] = hostCallSchema("mako:live-edit-queued").parse(args)
    return encodeRuntimeValue(host.editQueued(id, edit))
  }
  if (channel === "mako:live-snapshot") return encodeRuntimeValue(host.snapshot(String(args[0])) ?? null)
  throw new Error(`Unknown Mako host method ${channel}`)
}

const gateway = createFakeGateway()
const mac = { runtimeId: "mac", build: "send-race", invoke }
let served: ServedRuntime = await serveHostThroughGateway(await gateway.connectRuntime(), mac)
const actorOf = (deviceId: string): Actor => ({ kind: "client", client: deviceId === "phone" ? "web" : "desktop", deviceId })
const remote = new Map<string, ReturnType<typeof gatewayHostCalls>>()
for (const device of ["phone", "mac-b"]) remote.set(device, gatewayHostCalls(await gateway.connectClient(actorOf(device)), { runtimeId: "mac", actor: actorOf(device), history: false }))

type Client = "desktop" | "phone" | "mac-b"
const CLIENTS: Client[] = ["desktop", "phone", "mac-b"]

/** One call from a client, the way it reaches the host: the Mac's window on its socket, the others through the gateway. */
async function call(client: Client, channel: string, args: unknown[]): Promise<Json | undefined> {
  if (client === "desktop") return decodeRuntimeValue(await invoke(channel, args))
  return decodeRuntimeValue(await sendWithRepeats(channel, remote.get(client)!.call(channel, args), { conversationId: String(args[0]), runtime: "mac" }))
}

/* ---------------------------------------------------------- a person on each client */

/** What a client reads of the host's answers: a steer's state, and the IDs a snapshot holds. */
const ActionSchema = z.object({ state: z.object({ kind: z.string() }).loose() }).loose()
const HeldSchema = z.object({ requests: z.array(z.object({ id: z.string() }).loose()) }).loose()

/** What each message became, by its words: sent as a turn or a steer, under which IDs. */
type Sent = { text: string; client: Client; ids: string[]; steered?: string }

/**
 * A message sent the way the renderer sends it (`sendTo`): under one request ID, asked again under it after a lost
 * answer until the host has it (`replayUnconfirmedPrompts`), never under another. A refusal hands the words back, and
 * the person sends them again.
 */
async function prompt(client: Client, conversation: string, message: Sent, losesReply: boolean, requestId: string = randomUUID()): Promise<void> {
  if (!message.ids.includes(requestId)) message.ids.push(requestId)
  for (let attempt = 0; ; attempt++) {
    try {
      await call(client, "mako:live-prompt", [conversation, requestId, message.text, [], undefined])
      // The answer was lost on its way back: the client asks again under the same ID.
      if (losesReply && attempt === 0) continue
      return
    } catch (error) {
      const words = error instanceof Error ? error.message : String(error)
      // Its steer under this ID landed after all: that is where its words went.
      if (/already went into the running turn/.test(words)) {
        message.steered = requestId
        return
      }
      if (attempt > 400) throw new Error(`${client} never got ${message.text} in: ${words}`)
      // As `attemptSend`: whatever the error, a host that holds the request took it.
      const snapshot = HeldSchema.safeParse(await call(client, "mako:live-snapshot", [conversation]).catch(() => null)).data
      if (snapshot?.requests.some((request) => request.id === requestId)) return
      await delay(2 + random.int(6))
      // A refusal, not a lost call, comes back to the person, who sends it again as a new message.
      if (!(error instanceof RuntimeDisconnectedError) && !/restarting|shutting down|stopping|closed|no longer available|Unknown conversation/i.test(words)) return prompt(client, conversation, message, false)
    }
  }
}

/**
 * Steers the running turn as the client sees it, as `steerTo` does: under the message's one ID, which a steer the host
 * refused before the harness heard it (no turn running, another steer on its way) takes again as the next message.
 * One whose answer was lost is asked again under it.
 */
async function steer(client: Client, conversation: string, message: Sent, id: string = randomUUID()): Promise<void> {
  if (!message.ids.includes(id)) message.ids.push(id)
  const running = owner.snapshot(conversation)?.requests.find((request) => request.status === "dispatching")
  if (!running) return prompt(client, conversation, message, false, id)
  try {
    const action = ActionSchema.parse(await call(client, "mako:live-action", [conversation, { kind: "steer", id, requestId: running.id, text: message.text, attachments: [] }]))
    if (action.state.kind !== "not-accepted") {
      message.steered = id
      return
    }
  } catch (error) {
    const snapshot = owner.snapshot(conversation)
    const receipt = snapshot?.control?.actions?.find((action) => action.input.id === id)
    if (receipt && receipt.state.kind !== "not-accepted") {
      message.steered = id
      return
    }
    if (snapshot?.requests.some((request) => request.id === id)) return
    if (!receipt && error instanceof RuntimeDisconnectedError) {
      await delay(2 + random.int(6))
      return steer(client, conversation, message, id)
    }
  }
  await delay(random.int(3))
  return prompt(client, conversation, message, false, id)
}

/** A message that waited in the account while the Mac was off, taken by the Mac: heard on the list twice at once. */
async function waited(conversation: string, message: Sent): Promise<void> {
  const requestId = randomUUID()
  message.ids.push(requestId)
  const take = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await invoke("mako:live-prompt", [conversation, requestId, message.text, [], undefined])
      } catch (error) {
        if (attempt > 400) throw error
        await delay(2 + random.int(6))
      }
    }
  }
  await Promise.all([take(), delay(random.int(3)).then(take)])
}

/* ---------------------------------------------------------- the runs */

const requestsOf = (conversation: string): LiveRequest[] => owner.snapshot(conversation)?.requests ?? []

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
  for (const deadline = Date.now() + ms; !check(); await delay(2))
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
}

/** Restarts the host under the clients, as a quit and reopen does: in-flight calls fail, its journal is read again. */
async function restart(): Promise<void> {
  served.close()
  await owner.stop()
  owner = openHost()
  served = await serveHostThroughGateway(await gateway.connectRuntime(), mac)
}

/** Cuts the Mac's link to the gateway for a few milliseconds: calls on their way are lost, and asked again. */
async function cut(): Promise<void> {
  served.close()
  await delay(1 + random.int(8))
  served = await serveHostThroughGateway(await gateway.connectRuntime(), mac)
}

const settledStates = new Set<LiveRequest["status"]>(["completed", "canceled", "interrupted", "failed", "uncertain"])
let restarts = 0
let cuts = 0
let steered = 0
let retaken = 0
let lostReplies = 0
let paused = 0
let messages = 0

async function run(index: number): Promise<void> {
  const conversation = randomUUID()
  await owner.start("race", CWD, { conversationId: conversation })
  await until("the harness connects", () => owner.snapshot(conversation)?.session.connection === "connected")
  await until("the binding learns its native path", () => Boolean(owner.snapshot(conversation)?.control?.bindings[0]?.path))
  arrivals.clear()
  admittedBy.clear()
  heard.length = 0
  const count = 3 + random.int(5)
  const sent: Sent[] = []
  const work: Array<Promise<void>> = []
  const faults: Array<Promise<void>> = []
  const restarting = random.chance(0.08)
  for (let n = 0; n < count; n++) {
    const client = CLIENTS[random.int(CLIENTS.length - 1)]!
    const message: Sent = { text: `run ${index} message ${n} from ${client}`, client, ids: [] }
    sent.push(message)
    const at = random.int(10)
    const how = random.next()
    work.push(delay(at).then(() => {
      if (how < 0.12) {
        retaken++
        return waited(conversation, message)
      }
      if (how < 0.4) return steer(client, conversation, message)
      const loses = random.chance(0.15)
      if (loses) lostReplies++
      return prompt(client, conversation, message, loses)
    }))
  }
  if (random.chance(0.25)) {
    cuts++
    faults.push(delay(random.int(8)).then(cut))
  }
  if (restarting) {
    restarts++
    faults.push(delay(random.int(10)).then(restart))
  }
  await Promise.all(faults)
  await Promise.all(work)
  messages += sent.length

  // Once every client is done, the conversation comes to rest: nothing queued or sending, the session idle.
  const resting = () => {
    const snapshot = owner.snapshot(conversation)
    return Boolean(snapshot && snapshot.session.status !== "running" && snapshot.requests.every((request) => settledStates.has(request.status)) && !snapshot.control?.actions?.some((action) => action.state.kind === "dispatching"))
  }
  // A restart pauses what was still waiting, as a quit does, and the queue offers Resume: the person presses it.
  const held = () => requestsOf(conversation).filter((request) => request.status === "held")
  await until(`run ${index}: the conversation comes to rest or pauses`, () => resting() || held().length > 0)
  if (held().length) {
    assert.ok(restarting, `run ${index} (seed ${SEED}): only a restart pauses the queue`)
    paused += held().length
    const client = CLIENTS[random.int(2)]!
    for (const request of held()) await call(client, "mako:live-edit-queued", [conversation, { requestId: request.id, expectedText: request.text, change: { kind: "resume" } }])
  }
  try {
    await until(`run ${index}: the conversation comes to rest`, resting)
  } catch (error) {
    const snapshot = owner.snapshot(conversation)
    console.error(JSON.stringify({ session: snapshot?.session.status, connection: snapshot?.session.connection, requests: snapshot?.requests.map((request) => [request.text, request.status]) }, null, 1))
    throw error
  }
  // And takes the next message, which runs.
  const next: Sent = { text: `run ${index} the next message`, client: CLIENTS[random.int(2)]!, ids: [] }
  await prompt(next.client, conversation, next, false)
  try {
    await until(`run ${index}: the next message runs`, () => requestsOf(conversation).find((request) => request.id === next.ids.at(-1))?.status === "completed")
  } catch (error) {
    const snapshot = owner.snapshot(conversation)
    console.error(JSON.stringify({ restarts, transfers: snapshot?.control?.transfers, session: snapshot?.session, requests: snapshot?.requests.map((request) => [request.text, request.status, request.error]), heard }, null, 1))
    throw error
  }
  sent.push(next)

  const requests = requestsOf(conversation)
  const label = `run ${index} (seed ${SEED})`
  // 1. Exactly once.
  const ids = requests.map((request) => request.id)
  assert.equal(new Set(ids).size, ids.length, `${label}: no request ID is held twice`)
  for (const message of sent) {
    const reached = heard.filter((each) => each.text === message.text || each.text.endsWith(`\n\n${message.text}`))
    const action = owner.snapshot(conversation)?.control?.actions?.find((each) => each.input.id === message.steered)
    // A steer a restart cut off before the harness confirmed it is said as unconfirmed, and never sent again.
    if (action?.state.kind === "uncertain" && reached.length === 0) continue
    assert.equal(reached.length, 1, `${label}: "${message.text}" reached the harness once, not ${reached.length} times: ${JSON.stringify(heard)}`)
    if (message.steered) {
      steered++
      assert.equal(reached[0]!.kind, "steer", `${label}: "${message.text}" was steered`)
    } else assert.ok(message.ids.includes(reached[0]!.id), `${label}: "${message.text}" ran under one of the IDs its client sent it under`)
  }
  const persons = requests.filter((request) => sent.some((message) => message.ids.includes(request.id)))
  for (const request of persons) assert.ok(request.status === "completed" || request.status === "interrupted", `${label}: "${request.text}" ran, it isn't ${request.status}`)
  // 2. One serialization point, in arrival order.
  assert.equal(overlaps, 0, `${label}: the harness never ran two turns at once`)
  const turns = heard.filter((each) => each.kind === "turn").map((each) => each.id)
  const admitted = requests.map((request) => request.id).filter((id) => turns.includes(id))
  assert.deepEqual(turns, admitted, `${label}: turns ran in the order their messages were admitted`)
  const arrived = [...arrivals].flatMap(([host, ids]) => ids.filter((id) => admittedBy.get(id) === host && persons.some((request) => request.id === id)))
  assert.deepEqual(persons.map((request) => request.id), arrived, `${label}: messages were admitted in the order they arrived`)
  // 4. Nothing stuck.
  assert.ok(resting(), `${label}: it rests again`)
}

/**
 * The cases the runs reach only by chance, each made to happen. A host that restarts under a turn with messages queued
 * behind it pauses them, as a quit does, and Resume wakes the conversation and sends each once; and one request ID is
 * taken once, as a steer into a turn or as a message after it, whichever came first.
 */
async function cases(): Promise<void> {
  const client: Client = "phone"
  const conversation = randomUUID()
  await owner.start("race", CWD, { conversationId: conversation })
  await until("the harness connects", () => owner.snapshot(conversation)?.session.connection === "connected")
  await until("the binding learns its native path", () => Boolean(owner.snapshot(conversation)?.control?.bindings[0]?.path))
  heard.length = 0
  holding = true
  const first = randomUUID()
  await call(client, "mako:live-prompt", [conversation, first, "a long turn", [], undefined])
  await until("the long turn runs", () => owner.snapshot(conversation)?.session.status === "running")
  // One ID, steered first: it isn't taken again as a message.
  const steeredId = randomUUID()
  const action = ActionSchema.parse(await call(client, "mako:live-action", [conversation, { kind: "steer", id: steeredId, requestId: first, text: "into the turn", attachments: [] }]))
  assert.equal(action.state.kind, "accepted")
  await assert.rejects(call(client, "mako:live-prompt", [conversation, steeredId, "into the turn", [], undefined]), /already went into the running turn/, "a steered ID isn't taken again as a message")
  // One ID, queued first: it isn't steered too.
  const queued = [randomUUID(), randomUUID()]
  for (const [n, id] of queued.entries()) await call(client, "mako:live-prompt", [conversation, id, `queued ${n}`, [], undefined])
  await assert.rejects(call(client, "mako:live-action", [conversation, { kind: "steer", id: queued[0], requestId: first, text: "queued 0", attachments: [] }]), /already sent after the turn/, "a queued ID isn't steered too")
  // The host restarts under the turn: what waited behind it is paused, not left queued behind a turn that won't end.
  await restart()
  holding = false
  held.length = 0
  await call(client, "mako:live-snapshot", [conversation])
  const statuses = () => queued.map((id) => requestsOf(conversation).find((request) => request.id === id)?.status)
  assert.deepEqual(statuses(), ["held", "held"], "a restart pauses the queue")
  await delay(30)
  assert.deepEqual(statuses(), ["held", "held"], "and nothing sends it by itself")
  // Resume wakes the sleeping conversation and sends each, once, in order.
  for (const [n, id] of queued.entries()) await call(client, "mako:live-edit-queued", [conversation, { requestId: id, expectedText: `queued ${n}`, change: { kind: "resume" } }])
  await until("Resume sends what was paused", () => statuses().every((status) => status === "completed"))
  // The first after the restart carries Mako's note of the cut-short turn ahead of its words.
  assert.deepEqual(heard.map((each) => each.text.split("\n\n").at(-1)), ["a long turn", "into the turn", "queued 0", "queued 1"], "each once, in order")
  // Asked again under its ID after the restart, a message already sent is the same message.
  await call(client, "mako:live-prompt", [conversation, queued[1], "queued 1", [], undefined])
  await delay(30)
  assert.equal(heard.length, 4)
  console.log("send race cases: a restart pauses the queue and Resume sends it once; one ID is a steer or a message, never both")
}

try {
  await cases()
  for (let index = 0; index < RUNS; index++) await run(index)
  console.log(`send race: ${RUNS} runs (seed ${SEED}), ${messages} messages from three clients at once: ${steered} steered, ${retaken} taken twice from the account, ${lostReplies} replies lost and asked again, ${cuts} gateway cuts, ${restarts} host restarts (${paused} messages paused by them and resumed); each reached the harness once, one turn at a time in arrival order, nothing left queued`)
} finally {
  served.close()
  await owner.stop()
  rmSync(root, { recursive: true, force: true })
}

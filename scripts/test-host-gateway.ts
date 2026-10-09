import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { JsonSchema, OperationNameSchema, ReplySchema, type Actor, type ClientSession, type Json, type ServedRuntime } from "@mako/protocol"
import { createFakeGateway, type GatewayLogLine } from "@mako/protocol/fake-gateway"
import { hostCallInput, hostChannels } from "../electron/contracts/host-call-inputs.ts"
import { hostCallReplay } from "../electron/contracts/host-call-policy.ts"
import { CLIENT_CALLS, gatewayCalls, HOST_SCREEN_CALLS, isClientCall } from "../electron/contracts/client-calls.ts"
import { HOST_CALL_UNCONFIRMED_MESSAGE, HOST_RECONNECTING_MESSAGE, RuntimeDisconnectedError } from "../electron/contracts/host-connection.ts"
import { FixtureDeskRefusedError } from "../electron/contracts/fixture-desk-policy.ts"
import { fromHostOperation, hostOperationName, hostOperations, toHostOperation, toProtocolReply, toRuntimeReply, type HostChannel } from "../electron/contracts/host-operations.ts"
import { encodeRuntimeCall, runtimeFailure, type RuntimeReply, type RuntimeValue } from "../electron/contracts/runtime.ts"
import { createMakoBridge } from "../electron/contracts/renderer-bridge.ts"
import { gatewayHostCalls } from "../electron/gateway-client.ts"
import { gatewayClientId, serveHostThroughGateway } from "../electron/gateway-host.ts"
import { hostCorrelation, withHostClient } from "../electron/host-client.ts"
import { flushHostLog, hostLog, installHostLog } from "../electron/host-log.ts"
import { invokeRuntime } from "../electron/runtime-connection.ts"
import { invokeWithRecovery, type RecoveryLink } from "../electron/runtime-retry.ts"
import { startWebHost, type HostInvoke } from "../electron/web-host.ts"

const scratch = await mkdtemp(join(tmpdir(), "mako-host-gateway-"))
const logPath = join(scratch, "host.log")
installHostLog(logPath)
const channels = gatewayCalls(hostChannels)

// 1. Every host call is an operation, and nothing else is: a client call is answered by the client, and a remote client never acts on the host's screen.
{
  assert.equal(hostOperations.size, channels.length)
  for (const call of CLIENT_CALLS) assert.equal(hostOperations.has(hostOperationName(call)), false, `${call} is the client's, not an operation`)
  for (const call of HOST_SCREEN_CALLS) assert.equal(hostOperations.has(hostOperationName(call)), false, `${call} acts on the host's screen, so the gateway doesn't carry it`)
  for (const channel of channels) {
    const name = hostOperationName(channel)
    assert.ok(OperationNameSchema.safeParse(name).success, `${name} is a valid operation name`)
    assert.deepEqual(hostOperations.get(name), { channel, replay: hostCallReplay(channel) })
  }
  const stray = toHostOperation(encodeRuntimeCall("mako:not-a-call", []), { id: randomUUID(), target: { kind: "runtime", runtimeId: "laptop" }, actor: actor("stray"), correlationId: "c-1" })
  const refused = fromHostOperation(stray)
  assert.equal(refused.kind === "refused" && refused.problem.type, "urn:mako:problem:not-found")
  console.log(`Host operations: all ${channels.length} host calls are operations, named host.<call>, with the host's replay class`)
}

// 2. A host reply survives the trip through a protocol reply exactly.
{
  const replies: RuntimeReply[] = [
    { ok: true },
    { ok: true, value: null },
    { ok: true, value: { nested: [1, "two", false, null] } },
    { ok: false, error: "nothing to commit" },
    { ok: false, error: "" },
    { ok: false, error: "x".repeat(15_999) },
    runtimeFailure(new RuntimeDisconnectedError(true)),
    runtimeFailure(new RuntimeDisconnectedError(false)),
    runtimeFailure(new RuntimeDisconnectedError(true, "conversation-1")),
    runtimeFailure(new RuntimeDisconnectedError(false, "conversation-1")),
    runtimeFailure(new FixtureDeskRefusedError("A fixture desk only reads")),
  ]
  for (const reply of replies) {
    const carried = toProtocolReply(randomUUID(), "c-1", reply)
    ReplySchema.parse(carried)
    assert.deepEqual(JSON.parse(JSON.stringify(toRuntimeReply(carried))), JSON.parse(JSON.stringify(reply)), JSON.stringify(reply).slice(0, 200))
  }
  const owner = toProtocolReply(randomUUID(), "c-1", runtimeFailure(new RuntimeDisconnectedError(false, "conversation-1")))
  assert.equal(!owner.ok && owner.problem.outcome, "not-applied", "a refused owner never ran the call")
  console.log(`Host replies: ${replies.length} kinds of answer, from values to typed disconnects, come back exactly as the host gave them`)
}

/** What the host's handler saw, the way `registerIpc` hands it over. */
type Received = { channel: string; args: Json[]; client: string; history: boolean; correlationId: string | undefined }
const received: Received[] = []
const behaviours = new Map<string, () => Promise<Json>>()
const invoke: HostInvoke = async (channel, args, client = "web", history = false, correlationId) =>
  withHostClient(client, async () => {
    if (!channels.some((known) => known === channel)) throw new Error("Unknown Mako host method")
    const parsed = z.array(JsonSchema.optional()).parse(hostCallInput(z.enum(channels).parse(channel)).parse(args))
    const seen = parsed.map((arg) => arg ?? null)
    received.push({ channel, args: seen, client, history, correlationId: hostCorrelation() })
    hostLog("fixture", "handled", { channel })
    const behaviour = behaviours.get(channel)
    const value = behaviour ? await behaviour() : { channel, args: seen }
    return JSON.stringify({ ok: true, value })
  }, history, correlationId)

const socket = join(scratch, "host.sock")
const host = await startWebHost(socket, invoke, async () => new Response(""), undefined, { protocol: 1, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: [...channels] })
const gatewayLog: GatewayLogLine[] = []
const gateway = createFakeGateway({ log: (line) => gatewayLog.push(line) })
const laptop = { runtimeId: "laptop", build: "test", invoke }
let served: ServedRuntime = await serveHostThroughGateway(await gateway.connectRuntime(), laptop)
const desktop = actor("desktop-1")
const remote = gatewayHostCalls(await gateway.connectClient(desktop), { runtimeId: "laptop", actor: desktop, history: true })
const windowId = randomUUID()
const steady: RecoveryLink = { lost: () => assert.fail("nothing dropped"), whenConnected: async () => true }

const overSocket = (channel: string, args: readonly unknown[]) => {
  const correlationId = randomUUID()
  return invokeWithRecovery(channel, (attempt) => invokeRuntime(socket, windowId, channel, [...args], attempt, { history: true, correlationId }), steady)
}
const overGateway = (channel: string, args: readonly unknown[], link: RecoveryLink = steady) => invokeWithRecovery(channel, remote.call(channel, args), link)

try {
  // 3. Every host call, with every optional argument and with none, arrives the same both ways.
  {
    let calls = 0
    for (const channel of channels)
      for (const mode of ["full", "minimal"] as const) {
        const tuple = hostCallInput(channel)
        const args = tuple.def.items.map((item) => sample(item, mode, true))
        const viaSocket = await overSocket(channel, args)
        const atHostBySocket = received.at(-1)
        const viaGateway = await overGateway(channel, args)
        const atHostByGateway = received.at(-1)
        assert.ok(atHostBySocket && atHostByGateway && atHostBySocket !== atHostByGateway, `${channel} reached the host twice`)
        assert.deepEqual(atHostByGateway.args, atHostBySocket.args, `${channel} (${mode}) arguments`)
        assert.deepEqual(viaGateway, viaSocket, `${channel} (${mode}) answer`)
        assert.equal(atHostByGateway.client, gatewayClientId(desktop))
        assert.equal(atHostByGateway.history, true)
        assert.match(atHostByGateway.correlationId ?? "", /^[0-9a-f-]{36}$/)
        calls += 2
      }
    console.log(`Every host call: ${channels.length} calls, each with all optional arguments and with none, reached the host with the same arguments and gave the same answer over the socket and the gateway (${calls} calls)`)
  }

  // 4. The desktop's own bridge, unchanged, over either transport.
  {
    const bridgeOver = (run: (channel: string, args: readonly unknown[]) => Promise<RuntimeValue>, seen: string[]) => createMakoBridge({
      invoke: async <Result,>(channel: string, ...args: unknown[]) => {
        seen.push(channel)
        // SAFETY: as with Electron's ipcRenderer.invoke, the answer is the channel handler's own result, and createMakoBridge names its type per channel.
        return (await run(channel, args)) as Result
      },
      onEvent: () => () => {}, onTerminalEvent: () => () => {},
      pathForFile: () => null, resolveFileUrl: (url) => url,
    })
    const socketChannels: string[] = []
    const gatewayChannels: string[] = []
    const viaSocket = bridgeOver(overSocket, socketChannels)
    const viaGateway = bridgeOver((channel, args) => overGateway(channel, args), gatewayChannels)
    const outcome = async (method: Function) => {
      try { return { value: JSON.parse(JSON.stringify((await method()) ?? null)) } }
      catch (error) { return { error: error instanceof Error ? `${error.name}: ${error.message}` : "thrown" } }
    }
    let methods = 0
    for (const [name, method] of Object.entries(viaSocket)) {
      const twin = Object.entries(viaGateway).find(([other]) => other === name)?.[1]
      if (!(method instanceof Function) || !(twin instanceof Function)) continue
      socketChannels.length = 0
      gatewayChannels.length = 0
      const socketOutcome = await outcome(method)
      const gatewayOutcome = await outcome(twin)
      assert.deepEqual(gatewayChannels, socketChannels, `${name} calls the same host methods`)
      // A real client answers these before either transport (`test-client-calls.ts`).
      if (!socketChannels.length || socketChannels.some(isClientCall)) continue
      assert.deepEqual(gatewayOutcome, socketOutcome, `${name} answers the same`)
      methods++
    }
    assert.ok(methods > 150, `${methods} bridge methods reach the host`)
    console.log(`Desktop bridge: all ${methods} createMakoBridge methods that reach the host give the same answer or the same error over the gateway as over the socket`)
  }

  // 5. Failures keep their meaning: the same error, and the same delivery state for retries.
  {
    const failures: Array<[string, Error]> = [
      ["a handler's own error", new Error("nothing to commit")],
      ["a refused owner", new RuntimeDisconnectedError(false, "conversation-1")],
      ["an owner lost mid-call", new RuntimeDisconnectedError(true, "conversation-1")],
      ["a fixture refusal", new FixtureDeskRefusedError("A fixture desk only reads")],
    ]
    for (const [what, error] of failures) {
      behaviours.set("mako:git-commit", async () => { throw error })
      const bySocket = await rejection(overSocket("mako:git-commit", ["message"]))
      const byGateway = await rejection(overGateway("mako:git-commit", ["message"]))
      assert.deepEqual(describe(byGateway), describe(bySocket), what)
    }
    behaviours.delete("mako:git-commit")
    const invalid = [{ cwd: 42 }]
    assert.deepEqual(describe(await rejection(overGateway("mako:open-tab", invalid))), describe(await rejection(overSocket("mako:open-tab", invalid))), "a schema refusal")
    await assert.rejects(overGateway("mako:git-commit", [1n]), TypeError, "a BigInt can't be sent")
    console.log("Host failures: a handler's error, refused and lost owners, a fixture refusal and a schema refusal read the same over both transports")
  }

  // 6. A runtime that drops mid-call: reads and id-settled calls are repeated once it's back, the rest are left to the person.
  {
    const dropMidCall = async (channel: HostChannel, args: readonly unknown[]) => {
      let release = () => {}
      behaviours.set(channel, () => new Promise((resolve) => { release = () => resolve("first attempt") }))
      let lost = 0
      const link: RecoveryLink = {
        lost: () => { lost++ },
        whenConnected: async () => {
          behaviours.set(channel, async () => "second attempt")
          served = await serveHostThroughGateway(await gateway.connectRuntime(), laptop)
          return true
        },
      }
      const before = received.length
      const result = overGateway(channel, args, link)
      while (received.length === before) await new Promise((resolve) => setImmediate(resolve))
      served.close()
      const outcome = await result.then((value) => ({ value }), (error: Error) => ({ error }))
      release()
      behaviours.delete(channel)
      return { outcome, lost, runs: received.length - before }
    }
    for (const [channel, args] of [["mako:git-status", []], ["mako:live-prompt", ["conversation", randomUUID(), "hello"]]] as const) {
      const { outcome, lost, runs } = await dropMidCall(channel, args)
      assert.deepEqual(outcome, { value: "second attempt" }, `${channel} is repeated once the runtime is back`)
      assert.equal(lost, 1)
      assert.equal(runs, 2)
    }
    const commit = await dropMidCall("mako:git-commit", ["message"])
    assert.ok("error" in commit.outcome && commit.outcome.error instanceof RuntimeDisconnectedError && commit.outcome.error.unconfirmed)
    assert.equal(commit.outcome.error.message, HOST_CALL_UNCONFIRMED_MESSAGE)
    assert.equal(commit.runs, 1, "a commit whose answer was lost is never repeated")
    const repeats = gatewayLog.filter((line) => line.event === "operation" && line.attempt === 2)
    assert.deepEqual(repeats.map((line) => [line.op, line.outcome, line.answeredBy]), [["host.git-status", "ok", "runtime"], ["host.live-prompt", "ok", "runtime"]])
    for (const repeat of repeats)
      assert.ok(gatewayLog.some((line) => line.operationId === repeat.operationId && line.correlationId === repeat.correlationId && line.attempt === 1), `${repeat.op} is repeated as the same operation`)

    served.close()
    const offline = await rejection(overGateway("mako:git-commit", ["message"], { lost: () => {}, whenConnected: async () => false }))
    assert.ok(offline instanceof RuntimeDisconnectedError && !offline.unconfirmed, "a call no runtime received is known not to have run")
    assert.equal(offline.message, HOST_RECONNECTING_MESSAGE)
    served = await serveHostThroughGateway(await gateway.connectRuntime(), laptop)

    const session = await gateway.connectClient(desktop)
    let drops = 0
    const dropping: ClientSession = {
      subscribe: (request) => session.subscribe(request),
      call: (operation) => drops-- > 0 ? Promise.reject(new Error("The link to the gateway closed")) : session.call(operation),
    }
    const overDropping = gatewayHostCalls(dropping, { runtimeId: "laptop", actor: desktop })
    drops = 1
    const unsent = await rejection(invokeWithRecovery("mako:git-commit", overDropping.call("mako:git-commit", ["message"]), { lost: () => {}, whenConnected: async () => assert.fail("a commit is never repeated") }))
    assert.ok(unsent instanceof RuntimeDisconnectedError && unsent.unconfirmed, "a commit whose link dropped may have reached the gateway")
    drops = 1
    assert.deepEqual(await invokeWithRecovery("mako:git-status", overDropping.call("mako:git-status", []), { lost: () => {}, whenConnected: async () => true }), { channel: "mako:git-status", args: [] })
    console.log("Runtime loss: a read and a prompt are repeated as the same operation once the runtime is back; a commit whose runtime or link dropped is reported unconfirmed and never repeated; a call nobody received is known not to have run")
  }

  // 7. One call is findable by its correlation ID at every hop.
  {
    const traced = gatewayHostCalls(await gateway.connectClient(desktop), { runtimeId: "laptop", actor: desktop, trace: true })
    served.close()
    served = await serveHostThroughGateway(await gateway.connectRuntime(), { ...laptop, trace: true })
    await invokeWithRecovery("mako:git-status", traced.call("mako:git-status", []), steady)
    const line = gatewayLog.findLast((entry) => entry.event === "operation" && entry.op === "host.git-status")
    const correlationId = line?.correlationId
    assert.ok(correlationId, "the gateway logged the operation with its correlation ID")
    assert.equal(received.at(-1)?.correlationId, correlationId, "the host ran it under the same ID")
    const socketId = randomUUID()
    await invokeRuntime(socket, windowId, "mako:git-status", [], 1, { correlationId: socketId })
    assert.equal(received.at(-1)?.correlationId, socketId, "the socket carries the caller's ID too")
    await flushHostLog()
    const lines = (await readFile(logPath, "utf8")).split("\n")
    const hops = (id: string) => lines.filter((entry) => entry.includes(`correlationId=${id}`)).map((entry) => /^\S+ \S+ +(\S+ \S+)/.exec(entry)?.[1])
    assert.deepEqual(hops(correlationId), ["fixture handled", "gateway operation", "gateway-client operation"])
    assert.deepEqual(hops(socketId), ["fixture handled"])
    console.log("Correlation: one ID in the gateway's line, the runtime's, the client's and the line the host's handler wrote, and over the socket in the handler's line")
  }
} finally {
  served.close()
  await gateway.close()
  host.close()
  await flushHostLog()
  await rm(scratch, { recursive: true, force: true })
}

function actor(deviceId: string): Actor {
  return { kind: "client", client: "desktop", deviceId }
}

async function rejection(promise: Promise<RuntimeValue>): Promise<Error> {
  try { await promise } catch (error) { if (error instanceof Error) return error; throw new Error("Rejected with something other than an Error", { cause: error }) }
  throw new Error("Expected a rejection")
}

function describe(error: Error) {
  return {
    name: error.name,
    message: error.message,
    unconfirmed: error instanceof RuntimeDisconnectedError ? error.unconfirmed : undefined,
    conversationId: error instanceof RuntimeDisconnectedError ? error.conversationId : undefined,
  }
}

/**
 * A value the schema accepts. `full` fills every optional field and takes a union's first choice;
 * `minimal` leaves optional fields and top-level slots out and takes its last choice.
 */
function sample(schema: z.core.$ZodType, mode: "full" | "minimal", slot = false): Json | undefined {
  if (schema instanceof z.ZodOptional) return mode === "minimal" && slot ? undefined : sample(schema.unwrap(), mode)
  if (schema instanceof z.ZodString) return "text"
  if (schema instanceof z.ZodNumber) return 7
  if (schema instanceof z.ZodBoolean) return mode === "full"
  if (schema instanceof z.ZodNull) return null
  if (schema instanceof z.ZodUndefined) return undefined
  if (schema instanceof z.ZodLiteral) return JsonSchema.parse([...schema.values][0])
  if (schema instanceof z.ZodArray) return mode === "full" ? [sample(schema.element, mode) ?? null] : []
  if (schema instanceof z.ZodTuple) return schema.def.items.map((item) => sample(item, "full") ?? null)
  if (schema instanceof z.ZodUnion) return sample((mode === "full" ? schema.options[0] : schema.options.at(-1)) ?? z.null(), mode, slot)
  if (schema instanceof z.ZodRecord) return mode === "full" ? { key: sample(schema.valueType, mode) ?? null } : {}
  if (schema instanceof z.ZodIntersection) {
    const object = z.record(z.string(), JsonSchema)
    return { ...object.parse(sample(schema.def.left, mode)), ...object.parse(sample(schema.def.right, mode)) }
  }
  if (schema instanceof z.ZodObject) {
    const value: Record<string, Json> = {}
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Zod schema introspection API.
    for (const [key, field] of Object.entries(schema.shape)) {
      const filled = sample(field, mode, true)
      if (filled !== undefined) value[key] = filled
    }
    return value
  }
  throw new Error(`No sample for ${schema._zod.def.type}`)
}


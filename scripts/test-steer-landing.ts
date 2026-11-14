// A message the person sends into a running turn lands within about a second on every harness
// (`SteerCapability.landing`): a `native` harness's own steer, a `confirm` harness's own steer when it confirms
// delivery in time, and otherwise a stop of the turn with the words sent as the next message, carrying what the
// stopped turn left. The person's case of 2026-11-03: "Send now" on a message queued behind a Cursor cloud
// Thread's turn, which Cursor's SDK held 88 s, until that turn ended, while the composer said it was steering.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { LiveActionInput } from "@mako/host/contracts/live-actions"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver, ProviderSteerResult, SteerLanding } from "@mako/host/harnesses/live-driver"
import { STEER_LANDS_MS } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"
import { RuntimeThreads } from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { gatewayHostCalls, sendWithRepeats } from "@mako/host/contracts/gateway-host-calls"
import { decodeRuntimeValue, encodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"
import type { LiveAction } from "@mako/host/contracts/live-actions"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { ranOut } from "./lib/ran-out.ts"
import { installClaude } from "@mako/host/harnesses/claude/index"
import { installCodex } from "@mako/host/harnesses/codex/index"
import { installCursor } from "@mako/host/harnesses/cursor/index"
import { installDevin } from "@mako/host/harnesses/devin/index"
import { installGrok } from "@mako/host/harnesses/grok/index"
import { installOpenCode } from "@mako/host/harnesses/opencode/index"

const root = mkdtempSync(join(tmpdir(), "mako-steer-landing-"))

/**
 * A fixture turn ends only when Mako stops it, and its harness answers a held steer only then, so a steer that
 * waits for the turn's end (Cursor held the person's 88 s) waits forever. This is the hang guard on that, thirty
 * times the landing's own second.
 */
const HELD_MS = 30 * STEER_LANDS_MS

interface World {
  owner: LiveConversations
  id: string
  first: string
  /** Each prompt the harness was sent. */
  prompts: { text: string }[]
  steers: string[]
  cancels: number
  /** What the harness's own steer answers, and when. */
  answer: PromiseWithResolvers<ProviderSteerResult>
  running(): Promise<void>
  close(): void
}

async function world(provider: string, landing: SteerLanding | undefined, name: string): Promise<World> {
  const id = randomUUID(), first = randomUUID()
  const prompts: World["prompts"] = []
  const steers: string[] = []
  const answer = Promise.withResolvers<ProviderSteerResult>()
  let state: LiveSessionState
  let owner: LiveConversations
  let cancels = 0
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    resume: fixtureResume(),
    steering: { kind: "supported", lands: "step", ...landing && { landing }, answersOnEnd: true, via: "Injected driver fixture", steer: async (_id, input) => {
      steers.push(input.text)
      return answer.promise
    } },
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider, available: () => true,
    async start(cwd, options) {
      state = { id: options.conversationId, harness: provider, cwd, nativeId: "fixture", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
      return state
    },
    async prompt(_id, text, _attachments, _settings, dispatch) {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      prompts.push({ text })
      state = { ...state, status: "running", nativeRunId: randomUUID() }
      owner.observe({ type: "live-session", session: state })
    },
    async cancel() {
      cancels++
      await delay(20)
      state = { ...state, status: "ready", lastStop: "cancelled" }
      owner.observe({ type: "live-session", session: state })
      // A harness that holds steers answers each when its run ends.
      answer.resolve({ kind: "not-accepted", reason: "Cursor didn't take it into this turn, so it goes as the next message." })
    },
    async permission() {}, async setMode() {}, close() {},
  }
  owner = new LiveConversations({ root: join(root, name), appPath: root, driver: () => driver, history: async () => null, emit: () => {} })
  await owner.start(provider, root, { conversationId: id })
  for (let i = 0; owner.snapshot(id)?.session.connection !== "connected" && i < 100; i++) await delay(5)
  owner.submit(id, first, "build the importer")
  return {
    owner, id, first, prompts, steers, answer,
    get cancels() { return cancels },
    async running() {
      for (let i = 0; owner.snapshot(id)?.requests.find((request) => request.id === first)?.nativeRun === undefined && i < 200; i++) await delay(5)
      // The turn is in a command the agent won't see the end of before the steer.
      owner.observe({ type: "live-update", id, update: { kind: "tool", id: "build", title: "npm run build", status: "running" } })
    },
    async close() { answer.resolve({ kind: "accepted" }); await owner.stop() },
  }
}

async function until(what: string, test: () => boolean): Promise<void> {
  const by = performance.now() + HELD_MS
  while (!test()) {
    if (performance.now() > by) throw new Error(`${what}: still waiting after ${HELD_MS / 1_000} s, so it waited for the turn's end`)
    await delay(5)
  }
}

/** `work`, unless it waits for the turn's end. */
async function held<T>(what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const never = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still waiting after ${HELD_MS / 1_000} s, so it waited for the turn's end`)), HELD_MS)
  })
  try {
    return await Promise.race([work, never])
  } finally {
    clearTimeout(timer)
  }
}

try {
  // Claude Code, OpenCode, Grok and Devin read a steer only once the running command returns (11 s in the probe):
  // the person's message stops the turn and goes as the next message, ahead of what was queued.
  for (const kind of ["steer", "steer-queued"] as const) {
    const w = await world("claude", "restart", `restart-${kind}`)
    try {
      await w.running()
      const later = randomUUID()
      w.owner.submit(w.id, later, "and then the tests")
      const words = "stop, use the existing parser"
      const queuedId = randomUUID()
      if (kind === "steer-queued") w.owner.submit(w.id, queuedId, words)
      const input: LiveActionInput = kind === "steer"
        ? { kind, id: randomUUID(), requestId: w.first, text: words, attachments: [] }
        : { kind, id: randomUUID(), requestId: w.first, queuedRequestId: queuedId, text: words, attachments: [] }
      const receipt = await held("the steer's receipt", w.owner.act(w.id, input))
      assert.equal(receipt.state.kind, "accepted", "the steer's receipt says it's taken at once")
      assert.deepEqual(w.steers, [], "the harness's own steer, which would wait for the command, isn't used")
      await until("the message reaching the agent", () => w.prompts.length === 2)
      assert.equal(w.cancels, 1, "it reached the agent through Mako's stop, while the command still ran")
      const text = w.prompts[1]!.text
      assert.ok(text.endsWith(words), "the stopped turn's next message is the person's")
      assert.match(text, /Your previous turn was cut short at [\d:]+: the user sent the message below while you worked, and Mako stopped your turn so you read it at once\. Work you did before then is in place\./)
      assert.match(text, /These calls never returned a result[^]*- npm run build/, "the account names the call the stop cut off")
      assert.match(text, /stopped for this message, not because the user wanted it undone/)
      const requests = w.owner.snapshot(w.id)!.requests
      assert.equal(requests.find((request) => request.id === w.first)?.interruption?.reason, "steered")
      const own = kind === "steer" ? input.id : queuedId
      assert.deepEqual(requests.filter((request) => request.id !== w.first).map((request) => [request.id, request.status]), [[own, "dispatching"], [later, "queued"]],
        "the steer goes first; what was queued keeps its place after it")
      assert.equal((await w.owner.act(w.id, input)).state.kind, "accepted", "a retry finds the receipt")
      await delay(30)
      assert.equal(w.prompts.length, 2, "and sends nothing twice")
    } finally { await w.close() }
  }
  console.log("PASS: restart: the person's steer stops the turn and goes next, with the stopped turn's account, within a second")

  // The person's case: Cursor holds a steer while its agent is in a step it won't leave (a subagent, a long model
  // step), here for good. After `STEER_LANDS_MS` the turn is stopped for it; Cursor's late answer changes nothing.
  for (const kind of ["steer", "steer-queued"] as const) {
    const w = await world("cursor", "confirm", `confirm-held-${kind}`)
    try {
      await w.running()
      const words = "the code is the truth"
      const queuedId = randomUUID()
      if (kind === "steer-queued") w.owner.submit(w.id, queuedId, words)
      const input: LiveActionInput = kind === "steer"
        ? { kind, id: randomUUID(), requestId: w.first, text: words, attachments: [] }
        : { kind, id: randomUUID(), requestId: w.first, queuedRequestId: queuedId, text: words, attachments: [] }
      const sent = performance.now()
      const { result: receipt, waits } = await ranOut(() => held("the steer's receipt", w.owner.act(w.id, input)))
      const answered = performance.now() - sent
      assert.equal(receipt.state.kind, "accepted")
      assert.deepEqual(w.steers, [words], "Cursor's own steer is tried first")
      assert.ok(answered >= 995, `Cursor had its second to confirm (answered in ${Math.round(answered)} ms)`)
      assert.deepEqual(waits.filter((ms) => ms >= 1_000), [1_000], "the wait for Cursor's confirmation is the landing's second, and the receipt comes when it runs out")
      await until("the message reaching the agent", () => w.prompts.length === 2)
      assert.equal(w.cancels, 1, "it reached the agent through Mako's stop, not at the turn's end")
      assert.ok(w.prompts[1]!.text.endsWith(words))
      assert.match(w.prompts[1]!.text, /Mako stopped your turn so you read it at once/)
      const own = kind === "steer" ? input.id : queuedId
      assert.equal(w.owner.snapshot(w.id)!.requests.find((request) => request.id === own)?.status, "dispatching")
      assert.equal(w.owner.snapshot(w.id)!.control?.actions?.at(-1)?.state.kind, "accepted", "no notice is left saying it's still steering")
      await delay(50)
      assert.equal(w.prompts.length, 2, "Cursor's late refusal sends nothing again")
      assert.equal(w.owner.snapshot(w.id)!.blocks.filter((block) => block.type === "user" && block.text === words).length, 1, "the words show once")
    } finally { await w.close() }
  }
  console.log("PASS: confirm, held: a Cursor steer unconfirmed within a second stops the turn and goes next (the person's case)")

  // The same on a cloud Thread, as the Mac calls its machine: through the gateway to the machine's host, which runs
  // the Cursor turn. The Mac's call is answered within a second, not when the machine's turn ends.
  {
    const w = await world("cursor", "confirm", "cloud")
    const gateway = createFakeGateway()
    const runtimeId = "m-0123456789abcdef.g1", threadId = "t-00000000000000c1"
    const served = await serveHostThroughGateway(await gateway.connectRuntime(), {
      runtimeId, build: "test", threads: new RuntimeThreads(),
      invoke: async (channel, args) => {
        if (channel !== "mako:live-steer-queued") return JSON.stringify(null)
        // SAFETY: the only `mako:live-steer-queued` call is this test's own below, which sends a conversation and a steer.
        const [id, input] = args as [string, LiveActionInput]
        return encodeRuntimeValue(await w.owner.act(id, input))
      },
    })
    try {
      await gateway.assign(threadId, runtimeId)
      await w.running()
      const queuedId = randomUUID()
      w.owner.submit(w.id, queuedId, "the code is the truth")
      const client = await gateway.connectClient({ kind: "client", client: "desktop", deviceId: randomUUID() })
      const input: LiveActionInput = { kind: "steer-queued", id: randomUUID(), requestId: w.first, queuedRequestId: queuedId, text: "the code is the truth", attachments: [] }
      const call = gatewayHostCalls(client, { threadId, actor: { kind: "client", client: "desktop", deviceId: randomUUID() } }).call("mako:live-steer-queued", [w.id, input])
      // SAFETY: the machine's host answered `act`, a `LiveAction`, encoded as it encodes every value.
      const receipt = decodeRuntimeValue(await held("the Mac's call", sendWithRepeats("mako:live-steer-queued", call, { threadId }))) as LiveAction
      assert.equal(receipt.state.kind, "accepted")
      await until("the message reaching the machine's agent", () => w.prompts.length === 2)
      assert.equal(w.cancels, 1, "through the machine's stop, not at its turn's end")
      assert.ok(w.prompts[1]!.text.endsWith("the code is the truth"))
    } finally { served.close(); await w.close() }
  }
  console.log("PASS: cloud: the Mac's steer through the gateway lands on the machine's Cursor turn within a second")

  // Cursor cuts a running command short for a steer and confirms it at once: the turn goes on with it.
  {
    const w = await world("cursor", "confirm", "confirm-delivered")
    try {
      await w.running()
      setTimeout(() => w.answer.resolve({ kind: "accepted" }), 100)
      const receipt = await w.owner.act(w.id, { kind: "steer", id: randomUUID(), requestId: w.first, text: "use the existing parser", attachments: [] })
      assert.equal(receipt.state.kind, "accepted")
      await delay(50)
      assert.equal(w.cancels, 0, "a confirmed steer keeps the turn")
      assert.equal(w.prompts.length, 1)
    } finally { await w.close() }
  }
  console.log("PASS: confirm, delivered: a steer Cursor confirms in time keeps the turn and its work")

  // Codex's own steer is heard at once (its command yields), and an agent's steer always goes natively.
  for (const [landing, sender] of [["native", "person"], [undefined, "person"], ["restart", "native"]] as const) {
    const w = await world("codex", landing, `native-${landing}-${sender}`)
    try {
      await w.running()
      setTimeout(() => w.answer.resolve({ kind: "accepted" }), 10)
      const receipt = await w.owner.act(w.id, { kind: "steer", id: randomUUID(), requestId: w.first, text: "also the docs", attachments: [] }, sender)
      assert.equal(receipt.state.kind, "accepted")
      assert.deepEqual(w.steers, ["also the docs"])
      assert.equal(w.cancels, 0)
    } finally { await w.close() }
  }
  console.log("PASS: native: Codex's own steer, and an agent's steer on any harness")

  // Mid-turn on every harness, by the landing its real driver declares: the person's message queues and their steer
  // lands within a second; neither is refused, and a steer right behind another isn't either.
  const declared = sealedDrivers([installClaude, installCodex, installCursor, installDevin, installGrok, installOpenCode])
  assert.equal(declared.size, 6)
  for (const [provider, driver] of declared) {
    assert.equal(driver.steering.kind, "supported", `${provider} takes a message into its running turn`)
    const landing = driver.steering.kind === "supported" ? driver.steering.landing : undefined
    const w = await world(provider, landing, `mid-turn-${provider}`)
    try {
      await w.running()
      if (landing === undefined || landing === "native") setTimeout(() => w.answer.resolve({ kind: "accepted" }), 10)
      const queued = randomUUID()
      assert.equal(w.owner.submit(w.id, queued, "after this turn").status, "queued", `${provider}: a message mid-turn queues`)
      const receipt = await held(`${provider}'s steer`, w.owner.act(w.id, { kind: "steer", id: randomUUID(), requestId: w.first, text: "into this turn", attachments: [] }))
      assert.equal(receipt.state.kind, "accepted", `${provider}: the steer is taken`)
      if (landing === "restart" || landing === "confirm") {
        await until(`${provider}'s steer reaching the agent`, () => w.prompts.length === 2)
        assert.ok(w.prompts[1]!.text.endsWith("into this turn"), `${provider}: the steer goes first, ahead of what was queued`)
      }
    } finally { await w.close() }
  }
  console.log("PASS: mid-turn on all six harnesses, by each driver's own landing: a message queues and a steer lands within a second")
} finally {
  rmSync(root, { recursive: true, force: true })
}

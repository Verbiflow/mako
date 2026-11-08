import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { mock } from "node:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { toast } from "sonner"
import { z } from "zod"
import type { LiveAction, LiveActionInput, LiveSnapshot } from "@/lib/types"
import { HostCallTimeoutError, RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"

/**
 * The person's message always goes: the composer hands it to this device's outbox at once (`sendTo`, `steerTo`), it
 * shows where it stands (steering, on its way, waiting and why), and it reaches the host once, in the order sent, as
 * a steer or a message, whatever the host was doing when it was sent: away, slow, stalled, busy with a rewind or
 * another steer, or restarted mid-delivery. The host here is a script that keeps what it took by ID, as
 * `LiveConversations.submit` does. The last part runs as a reloaded page, in a process of its own, on the storage the
 * first left.
 *
 *   tsx --tsconfig tsconfig.app.json scripts/test-durable-outbox.ts
 */
const reloaded = process.argv[2] === "--reload"
const directory = reloaded ? process.argv[3]! : mkdtempSync(join(tmpdir(), "mako-durable-outbox-"))
const storage = join(directory, "storage.json")
const kept = (): Record<string, string> => {
  try {
    return z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(storage, "utf8")))
  } catch {
    return {}
  }
}
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() {
      return Object.keys(kept()).length
    },
    key: (index: number) => Object.keys(kept())[index] ?? null,
    getItem: (key: string) => kept()[key] ?? null,
    setItem: (key: string, value: string) => writeFileSync(storage, JSON.stringify({ ...kept(), [key]: value })),
    removeItem: (key: string) => {
      const { [key]: _gone, ...rest } = kept()
      writeFileSync(storage, JSON.stringify(rest))
    },
  },
})
Object.defineProperty(globalThis, "window", { value: { addEventListener() {}, removeEventListener() {} }, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { acpStore, updateAcpConversation } = await import("../src/state/acp-state")
// What the window's own code writes of a conversation goes through the door (`receiveLive`), or the suite fails.
const { failAroundTheDoor } = await import("./live-door-watch")
const { receivingLive: receivingThroughTheDoor, readingLive: readingThroughTheDoor } = await import("../src/state/live-door")
failAroundTheDoor(acpStore, receivingThroughTheDoor, readingThroughTheDoor)
const { applyLiveSnapshot } = await import("../src/state/live-recovery")
const { restorePendingMessages, sendTo, sendWaitingNow, steerTo } = await import("../src/state/acp-queue")
const { pendingMessages } = await import("../src/state/message-outbox")
const { hostConnectionStore } = await import("../src/state/host-connection")
const { promptDelivery } = await import("../src/state/prompt-delivery")
installMockBridge()
mock.method(toast, "error", () => "fixture")
mock.method(toast, "info", () => "fixture")
const bridge = getMako()
mock.method(bridge, "liveRead", async () => {
  throw new Error("Unknown Mako host method")
})

const conversation = auditId(800)
const turn = auditId(801)

interface Took { how: "prompt" | "steer"; id: string; text: string }
/** The scripted host: what it took, by ID and in order, how often it was asked, and how it answers now. */
interface ScriptedHost { took: Took[]; asked: number; running: boolean; refusals: Error[]; stallMs: number; answerLost: boolean }
const host: ScriptedHost = {
  took: [],
  asked: 0,
  running: false,
  /** Thrown at the next tries, one each, before the host takes anything. */
  refusals: [],
  /** How long it takes to answer. */
  stallMs: 0,
  /** Whether it takes the message and then loses its answer (`HostCallTimeoutError`): the bridge's deadline. */
  answerLost: false,
}
let revision = 100
function snapshot(): LiveSnapshot {
  const base = auditSnapshot(1, "claude")
  base.session.id = conversation
  base.session.status = host.running ? "running" : "ready"
  base.revision = ++revision
  base.requests = [
    { id: turn, text: "a long turn", attachments: [], status: host.running ? "dispatching" : "completed" },
    ...host.took.filter((each) => each.how === "prompt").map((each) => ({ id: each.id, text: each.text, attachments: [], status: "queued" as const })),
  ]
  const steers = host.took.filter((each) => each.how === "steer")
  if (steers.length)
    base.control = {
      activeBindingId: auditId(802), bindings: [], merges: [], transfers: [],
      actions: steers.map((each) => ({ input: { kind: "steer" as const, id: each.id, requestId: turn, text: each.text, attachments: [] }, digest: "fixture", bindingId: auditId(802), createdAt: 1, state: { kind: "accepted" as const } })),
    }
  return base
}
async function answer(take: () => void): Promise<void> {
  host.asked++
  if (host.stallMs) await new Promise((resolve) => setTimeout(resolve, host.stallMs))
  const refusal = host.refusals.shift()
  if (refusal) throw refusal
  take()
  if (host.answerLost) throw new HostCallTimeoutError(true)
}
mock.method(bridge, "livePrompt", (_id: string, requestId: string, text: string) => answer(() => {
  if (!host.took.some((each) => each.id === requestId)) host.took.push({ how: "prompt", id: requestId, text })
}))
mock.method(bridge, "liveAction", async (_id: string, input: LiveActionInput) => {
  await answer(() => {
    if (input.kind === "steer" && !host.took.some((each) => each.id === input.id)) host.took.push({ how: "steer", id: input.id, text: input.text })
  })
  return { input, digest: "fixture", bindingId: auditId(802), createdAt: 1, state: { kind: "accepted" } } satisfies LiveAction
})
mock.method(bridge, "liveSnapshot", async () => snapshot())

function reset(running = false): void {
  host.took = []
  host.asked = 0
  host.running = running
  host.refusals = []
  host.stallMs = 0
  host.answerLost = false
  hostConnectionStore.set({ kind: "connected" })
  applyLiveSnapshot(snapshot())
  updateAcpConversation(conversation, (current) => ({ ...current, pendingPrompts: [] }))
  acpStore.set({ activeKey: conversation })
}
const pending = () => acpStore.get().conversations[conversation]?.pendingPrompts ?? []
const waiting = (id: string) => pending().find((prompt) => prompt.id === id)?.waiting
const outbox = () => pendingMessages().filter((command) => command.kind !== "start").map((command) => command.requestId)
async function until(test: () => boolean, ms = 10_000): Promise<void> {
  const by = Date.now() + ms
  while (!test()) {
    if (Date.now() > by) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

if (!reloaded) {
  try {
    // 1. Mako is away: three messages are taken at once, each shown waiting and kept, and nothing is asked of the host.
    reset()
    hostConnectionStore.set({ kind: "disconnected", message: "Reconnecting" })
    const away = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    for (const [index, id] of away.entries()) assert.equal(await sendTo(conversation, `away ${index}`, [], id), true, "the composer's message is taken")
    assert.equal(host.asked, 0)
    assert.deepEqual(away.map(waiting), ["Waiting for Mako to reconnect", "Waiting for Mako to reconnect", "Waiting for Mako to reconnect"])
    assert.deepEqual(outbox(), away, "the outbox keeps all three, in order")
    const queued = promptDelivery({ ...acpStore.get().conversations[conversation]!, session: { status: "ready" } })
    assert.equal(queued.starting, null, "none is drawn as sent")
    assert.deepEqual(queued.queued.map((prompt) => prompt.id), away, "each shows in the queue, waiting")
    // Mako is back: each reaches it once, in order.
    hostConnectionStore.set({ kind: "connected" })
    await sendWaitingNow(conversation)
    assert.deepEqual(host.took.map((each) => each.id), away)
    assert.deepEqual(outbox(), [])
    assert.deepEqual(away.map(waiting), [undefined, undefined, undefined])
    console.log("Durable outbox: away — taken at once, shown waiting, kept, then each delivered once in order")

    // 2. The host is busy with a rewind: the message waits, says why, and one sent after it waits behind it.
    reset()
    host.refusals = [new Error("Wait for the workspace rewind to finish before sending")]
    const first = crypto.randomUUID(), second = crypto.randomUUID()
    assert.equal(await sendTo(conversation, "first", [], first), true)
    assert.equal(waiting(first), "Wait for the workspace rewind to finish before sending")
    assert.equal(await sendTo(conversation, "second", [], second), true)
    assert.equal(waiting(second), "Waiting behind an earlier message")
    assert.equal(host.took.length, 0, "the second doesn't overtake the first")
    await sendWaitingNow(conversation)
    assert.deepEqual(host.took.map((each) => each.id), [first, second])
    console.log("Durable outbox: busy — a not-yet refusal waits with the host's reason; later messages wait behind it; then both in order")

    // 3. The host's event loop stalls 5 s: the next message is shown at once, and reaches the host after the first.
    reset()
    host.stallMs = 5_000
    const slow = crypto.randomUUID(), next = crypto.randomUUID()
    const slowSend = sendTo(conversation, "slow", [], slow)
    const nextSend = sendTo(conversation, "next", [], next)
    assert.deepEqual(pending().map((prompt) => prompt.id), [slow, next], "both show at once, in order")
    assert.equal(host.took.length, 0, "while the stalled host has taken neither")
    assert.deepEqual(await Promise.all([slowSend, nextSend]), [true, true])
    assert.deepEqual(host.took.map((each) => each.id), [slow, next])
    assert.equal(host.asked, 2)
    console.log("Durable outbox: slow host — 5 s stalls hold nothing on screen, and order holds")

    // 4. The host took it but its answer was lost to the bridge's deadline: it waits, and asking again sends nothing twice.
    reset()
    host.answerLost = true
    const lost = crypto.randomUUID()
    mock.method(bridge, "liveSnapshot", async () => { throw new RuntimeDisconnectedError(true) })
    assert.equal(await sendTo(conversation, "lost answer", [], lost), true)
    assert.equal(waiting(lost), "Mako is busy and hasn't answered yet")
    host.answerLost = false
    mock.method(bridge, "liveSnapshot", async () => snapshot())
    await sendWaitingNow(conversation)
    await sendWaitingNow(conversation)
    assert.deepEqual(host.took.map((each) => each.id), [lost], "taken once")
    assert.deepEqual(outbox(), [])
    // The same message sent twice at once is one try.
    const twice = crypto.randomUUID()
    const asked = host.asked
    await Promise.all([sendTo(conversation, "twice", [], twice), sendTo(conversation, "twice", [], twice)])
    assert.equal(host.asked - asked, 1)
    console.log("Durable outbox: a lost answer waits and is asked again under its ID; duplicate tries reach the host once")

    // 5. Mid-turn steers: shown as steering at once; a host busy with the previous steer is asked again, not refused.
    reset(true)
    host.refusals = [new Error("Resolve the previous provider action before sending another"), new Error("Resolve the previous provider action before sending another")]
    const steer = crypto.randomUUID()
    const steering = steerTo(conversation, "use the parser", [], steer)
    assert.equal(pending().find((prompt) => prompt.id === steer)?.steering, true, "shown as steering at once")
    assert.equal(await steering, true)
    assert.deepEqual(host.took, [{ how: "steer", id: steer, text: "use the parser" }], "steered once, not queued")
    assert.equal(pending().some((prompt) => prompt.id === steer), false, "the turn shows it now")
    // Away mid-turn: it waits as a steer, and goes into the turn once Mako is back.
    hostConnectionStore.set({ kind: "disconnected", message: "Reconnecting" })
    const awaySteer = crypto.randomUUID()
    assert.equal(await steerTo(conversation, "also the docs", [], awaySteer), true)
    assert.equal(waiting(awaySteer), "Waiting for Mako to reconnect")
    hostConnectionStore.set({ kind: "connected" })
    await sendWaitingNow(conversation)
    assert.deepEqual(host.took.map((each) => [each.how, each.id]), [["steer", steer], ["steer", awaySteer]])
    // The turn ended while it waited: it goes as the next message instead, once.
    hostConnectionStore.set({ kind: "disconnected", message: "Reconnecting" })
    const late = crypto.randomUUID()
    await steerTo(conversation, "after all that", [], late)
    host.running = false
    applyLiveSnapshot(snapshot())
    hostConnectionStore.set({ kind: "connected" })
    await sendWaitingNow(conversation)
    assert.deepEqual(host.took.at(-1), { how: "prompt", id: late, text: "after all that" })
    console.log("Durable outbox: steers — shown at once, a busy host asked again, an away one waits as a steer, a turn that ended takes it next")

    // 6. The page restarts mid-delivery: the reloaded page sends what the outbox kept once, and nothing the host already took.
    reset()
    hostConnectionStore.set({ kind: "disconnected", message: "Reconnecting" })
    const survivor = crypto.randomUUID()
    await sendTo(conversation, "survives a restart", [], survivor)
    for (const took of [false, true]) {
      const result = spawnSync(process.execPath, [createRequire(import.meta.url).resolve("tsx/cli"), "--tsconfig", "tsconfig.app.json", fileURLToPath(import.meta.url), "--reload", directory, survivor, String(took)], { encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr || result.stdout)
    }
    console.log("Durable outbox: a restart mid-delivery sends the kept message once, and never one the host already took")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  process.exit(0)
} else {
  const id = process.argv[4]!
  const took = process.argv[5] === "true"
  const before = kept()
  try {
    reset()
    if (took) {
      host.took = [{ how: "prompt", id, text: "survives a restart" }]
      applyLiveSnapshot(snapshot())
    }
    const asked = host.asked
    await restorePendingMessages()
    await until(() => outbox().length === 0)
    assert.equal(host.took.filter((each) => each.id === id).length, 1, "the host holds it once")
    assert.equal(host.asked - asked, took ? 0 : 1, took ? "one the host took isn't asked again" : "one it never heard is sent")
  } finally {
    writeFileSync(storage, JSON.stringify(before))
  }
  process.exit(0)
}

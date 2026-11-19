// Stop on Claude Code keeps its process where the CLI can do all of what Stop means, and closes it where it can't
// (`keepStopped` in `harnesses/claude/sdk-driver.ts`). Against a fake query that counts what it is asked:
//
// - a CLI that says `interrupt_cancel_queued_v1` is asked to interrupt with `cancelQueued`, and once the stopped
//   turn's result arrives the session is ready, connected and interrupted, with nothing closed;
// - its own message still queued when Stop came (the receipt lists it as cancelled) needs no result;
// - each background task still running is stopped by its id, with or without a turn;
// - a CLI that never said the capability, one that doesn't answer in time, one that leaves messages queued and one
//   that had another message queued behind the running command all have their process closed, as Stop always did,
//   and Stop answers either way.
//
//   npx tsx scripts/test-claude-stop.ts
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { SDKControlInterruptResponse, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { createClaudeSdkDriver } from "@mako/host/harnesses/claude/sdk-driver"
import { admitted } from "./fixtures/admitted-start.ts"

class Messages implements AsyncIterable<SDKMessage> {
  private readonly items: SDKMessage[] = []
  private wake: (() => void) | undefined
  private closed = false
  send(message: SDKMessage) {
    this.items.push(message)
    this.wake?.()
  }
  close() {
    this.closed = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    while (!this.closed) {
      const message = this.items.shift()
      if (message) yield message
      else await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }
}

const home = await mkdtemp(join(tmpdir(), "mako-claude-stop-"))

interface Fixture {
  /** What the CLI says it can do at each turn's `init`. */
  capabilities: readonly string[]
  /** What the fake answers an interrupt with; `never` leaves it unanswered. */
  interrupt: "never" | ((run: string) => SDKControlInterruptResponse)
  /** Whether the stopped turn's result follows the interrupt. */
  result: boolean
}

/** One session on a fake CLI, a turn running, and what a Stop then asked of it. */
async function stopped(name: string, fixture: Fixture, before?: (messages: Messages, id: string) => void) {
  const messages = new Messages()
  const events: LiveDriverEvent[] = []
  const asked: string[] = []
  let closed = false
  let input: AsyncIterator<SDKUserMessage> | undefined
  const id = randomUUID()
  // SAFETY: the two result shapes share these fields, and the driver reads only `is_error` and the uuids of this one.
  const result = (subtype: "success" | "error_during_execution"): SDKMessage => ({
    type: "result", subtype, uuid: randomUUID(), session_id: id,
    duration_ms: 1, duration_api_ms: 1, is_error: subtype !== "success", num_turns: 1, stop_reason: null, total_cost_usd: 0,
    modelUsage: {}, permission_denials: [], errors: [], result: "",
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      fallback_credit: { status: { type: "redeemed" } }, inference_geo: "", iterations: [], output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: "standard", speed: "standard" },
  } as SDKMessage)
  let run: ReturnType<typeof randomUUID> = randomUUID()
  const driver = createClaudeSdkDriver({
    available: () => true,
    configure: async () => ({ options: { env: { CLAUDE_CONFIG_DIR: home } }, account: { name: "fixture-launch" } }),
    configDir: () => home,
    stopKeptMs: 60,
    interruptTimeoutMs: 60,
    query: async (options) => {
      input = options.prompt[Symbol.asyncIterator]()
      return {
        [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
        initializationResult: async () => ({ commands: [], agents: [], output_style: "default", available_output_styles: [], models: [], account: {} }),
        setModel: async () => {},
        applyFlagSettings: async () => {},
        setPermissionMode: async () => {},
        stopTask: async (task) => { asked.push(`stop_task ${task}`) },
        interrupt: (given) => {
          asked.push(`interrupt ${JSON.stringify(given ?? {})}`)
          if (fixture.interrupt === "never") return new Promise(() => {})
          if (fixture.result) queueMicrotask(() => messages.send(result("error_during_execution")))
          return Promise.resolve(fixture.interrupt(run))
        },
        close: () => {
          closed = true
          messages.close()
        },
      }
    },
  })
  await driver.start("/disposable", admitted("claude", { conversationId: id, emit: (event) => events.push(event) }))
  const session = () => events.findLast((event) => event.type === "live-session")?.session
  const turn = async (text: string) => {
    run = randomUUID()
    await driver.prompt(id, text, [], undefined, { operationId: randomUUID(), attemptId: run, report: () => {} })
    await input?.next()
    messages.send({
      type: "system", subtype: "init", uuid: randomUUID(), session_id: id, apiKeySource: "none", claude_code_version: "2.1.300", cwd: "/disposable",
      tools: [], mcp_servers: [], model: "fixture", permissionMode: "default", slash_commands: [], output_style: "default", skills: [], plugins: [],
      capabilities: [...fixture.capabilities],
    })
    await delay(5)
  }
  await turn("a first turn, so the CLI has said what it can do")
  messages.send(result("success"))
  for (const deadline = Date.now() + 2_000; session()?.status !== "ready"; await delay(5)) if (Date.now() > deadline) throw new Error(`${name}: the first turn never ended`)
  before?.(messages, id)
  await delay(5)
  return {
    driver, id, asked, session, turn, messages,
    closed: () => closed,
    async stop() {
      const began = performance.now()
      await driver.cancel(id)
      return performance.now() - began
    },
    async end() {
      await driver.close(id)
    },
  }
}

const KEEPS = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"]
const nothingQueued = (): SDKControlInterruptResponse => ({ still_queued: [], cancelled: [] })

try {
  // Kept: the interrupt asks for the queue to be dropped, and the stopped turn's result ends it interrupted.
  {
    const kept = await stopped("kept", { capabilities: KEEPS, interrupt: nothingQueued, result: true })
    await kept.turn("stop me")
    await kept.stop()
    assert.deepEqual(kept.asked, ['interrupt {"cancelQueued":true}'], "one interrupt, with the queue dropped")
    assert.equal(kept.closed(), false, "the process is kept")
    assert.equal(kept.session()?.status, "ready")
    assert.equal(kept.session()?.connection, "connected")
    assert.equal(kept.session()?.lastStop, "interrupted")
    assert.equal(kept.session()?.error, undefined, "the aborted turn's own result is not an error")
    // The same process takes the next message, and a second Stop.
    await kept.turn("and again")
    await kept.stop()
    assert.equal(kept.closed(), false)
    assert.equal(kept.asked.length, 2)
    // With nothing running, Stop asks no interrupt.
    await kept.stop()
    assert.equal(kept.asked.length, 2, "an idle Stop interrupts nothing")
    assert.equal(kept.session()?.connection, "connected")
    await kept.end()
  }

  // Its own message was still queued: the receipt says it's cancelled, and no result will come.
  {
    const queued = await stopped("own-queued", { capabilities: KEEPS, interrupt: (run) => ({ still_queued: [], cancelled: [run] }), result: false })
    await queued.turn("never started")
    const took = await queued.stop()
    assert.ok(took < 50, `answered from the receipt, not the bound (${Math.round(took)} ms)`)
    assert.equal(queued.closed(), false)
    assert.equal(queued.session()?.status, "ready")
    assert.equal(queued.session()?.lastStop, "interrupted")
    await queued.end()
  }

  // Background tasks are stopped one by one, with no turn running.
  {
    const background = await stopped("background", { capabilities: KEEPS, interrupt: nothingQueued, result: true }, (messages, id) => {
      // SAFETY: a task's start as the CLI reports it; the SDK's type also carries fields the driver doesn't read.
      const started = (task: string) => ({
        type: "system", subtype: "task_started", task_id: task, tool_use_id: `call-${task}`, description: "a background command", task_type: "local_bash",
        is_backgrounded: true, uuid: randomUUID(), session_id: id,
      } as SDKMessage)
      for (const task of ["task-one", "task-two"]) messages.send(started(task))
    })
    await background.stop()
    assert.deepEqual(background.asked, ["stop_task task-one", "stop_task task-two"], "each running task is stopped by its id, and nothing is interrupted")
    assert.equal(background.closed(), false)
    assert.equal(background.session()?.lastStop, "interrupted")
    assert.ok(!background.session()?.backgroundTasks)
    await background.end()
  }

  // Closed, as Stop always did: a CLI that can't, one that doesn't answer, one that leaves or held messages queued.
  for (const [name, fixture, why] of [
    ["older", { capabilities: ["interrupt_receipt_v1"], interrupt: nothingQueued, result: true }, "a CLI that can't drop its queue on an interrupt"],
    ["silent", { capabilities: KEEPS, interrupt: "never", result: false }, "an interrupt unanswered within the bound"],
    ["no-result", { capabilities: KEEPS, interrupt: nothingQueued, result: false }, "a stopped turn that reports no end within the bound"],
    ["survivors", { capabilities: KEEPS, interrupt: () => ({ still_queued: [randomUUID()], cancelled: [] }), result: true }, "messages the interrupt left queued"],
    ["held", { capabilities: KEEPS, interrupt: () => ({ still_queued: [], cancelled: [randomUUID()] }), result: false }, "a message queued behind the running command"],
  ] as const) {
    const closing = await stopped(name, fixture)
    await closing.turn("stop me")
    const took = await closing.stop()
    assert.equal(closing.closed(), true, `${why}: the process is closed`)
    assert.equal(closing.session()?.status, "ready", why)
    assert.equal(closing.session()?.connection, "disconnected", why)
    assert.equal(closing.session()?.lastStop, "interrupted", why)
    assert.ok(took < 1_000, `${why}: Stop answers within its bound (${Math.round(took)} ms)`)
    if (name === "held") assert.ok(took < 50, `${why}: closed at once, without waiting for the command (${Math.round(took)} ms)`)
    assert.equal(closing.asked.filter((each) => each.startsWith("interrupt")).length, 1, `${why}: one interrupt, never a second`)
    await closing.end()
  }
  console.log("PASS: Stop on Claude Code keeps the process where the CLI ends the turn, its queue and its background work, and closes it where it can't")
} finally {
  await rm(home, { recursive: true, force: true })
}

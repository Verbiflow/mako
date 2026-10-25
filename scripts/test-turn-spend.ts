import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveDriverEvent, LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { conversationSpend } from "@mako/host/contracts/usage-ledger"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { usageSummary } from "@mako/host/usage/summary"
import { usageHarnesses } from "@mako/host/harnesses/usage-harnesses"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

// Every token the conversation's meter reads belongs to one turn: spend
// between turns (a background subagent working while its parent is idle)
// counts in the next turn, Mako's or the harness's own; a turn the harness
// runs without a request is recorded as its own; and what was spent after
// the last turn when the process goes is kept as `after`.

const providerHost = createHarnessHost(detachedHarnessContext(new NativeStores(false)))
const tokens = (input: number) => ({ input, cacheRead: 0, cacheWrite: 0, output: input / 10 })
const root = mkdtempSync(join(tmpdir(), "mako-turn-spend-"))
const conversations = join(root, "conversations")
let emit: (event: LiveDriverEvent) => void = () => {}
let session: LiveSessionState | undefined
const report = (status: LiveSessionState["status"], input: number, extra: Partial<LiveSessionState> = {}) => {
  session = { ...session!, status, usage: { tokens: tokens(input) }, ...extra }
  emit({ type: "live-session", session })
}
let promptReply: (() => void) | undefined
const driver: ProviderLiveDriver = {
  ...noCapabilities,
  resume: fixtureResume(),
  launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
  turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
  provider: "cursor",
  available: () => true,
  async start(cwd, options) {
    emit = options.emit
    session = {
      id: options.conversationId, nativeId: `agent-${options.conversationId}`, harness: "cursor", cwd,
      status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [],
      settings: { model: "composer-2" }, usage: { tokens: tokens(100) },
    }
    return session
  },
  async prompt(_id, _text, _attachments, _settings, dispatch) {
    dispatch.report({ kind: "submitted", source: "transport-call" })
    report("running", session!.usage!.tokens!.input)
    promptReply?.()
  },
  async cancel() {},
  async permission() {},
  async setMode() {},
  async close() {},
}
const owner = new LiveConversations({
  root: conversations,
  appPath: root,
  driver: () => driver,
  emit: () => {},
  history: async (path) => ({
    ref: { harness: "claude", nativeId: "source", path, cwd: "/work/spend", title: "Spend" },
    entries: [{ type: "user", id: "u1", text: "Hello" }],
    start: 0, total: 1, hasEarlier: false,
  }),
  resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
})
const until = async (what: string, ready: () => boolean) => {
  for (const deadline = Date.now() + 5_000; !ready();) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const send = async (id: string, settleAt: number) => {
  const requestId = randomUUID()
  promptReply = () => setTimeout(() => report("ready", settleAt), 5)
  owner.transfer(id, { id: requestId, provider: "cursor", text: "Go", attachments: [] })
  await until("the request to settle", () => owner.snapshot(id)?.requests.find((request) => request.id === requestId)?.status === "completed")
  return owner.snapshot(id)!.requests.find((request) => request.id === requestId)!
}
const spendOf = (snapshot: LiveSnapshot) =>
  conversationSpend(snapshot.requests, snapshot.session.usage, "cursor", { harnessTurns: snapshot.harnessTurns, spentThrough: snapshot.spentThrough, running: snapshot.session.status === "running" })
const flush = () => new Promise((resolve) => setTimeout(resolve, 50))

try {
  const id = randomUUID()
  await owner.capture(id, join(root, "source.jsonl"))

  // A turn Mako sent counts from the meter as it was sent.
  const first = await send(id, 160)
  assert.deepEqual(first.spend?.tokens, tokens(60))

  // Between turns a background subagent spends; the panel shows it as work since the last turn.
  report("ready", 200)
  await flush()
  const between = spendOf(owner.snapshot(id)!)
  assert.deepEqual(between.since?.tokens, tokens(40), "spent since the last turn")
  assert.equal(between.turns, 1, "work since the last turn is no turn of its own")
  assert.equal(between.tokens?.input, 100, "and every token the meter read is in the total")

  // The next turn Mako sends counts it.
  const second = await send(id, 230)
  assert.deepEqual(second.spend?.tokens, tokens(70), "the next turn counts what was spent while idle")

  // The harness runs a turn of its own on its subagent's report: recorded with what it spent since the last turn.
  report("ready", 250)
  report("running", 250)
  await flush()
  assert.equal(spendOf(owner.snapshot(id)!).running?.tokens?.input, 20, "a turn the harness runs counts from the last turn's end")
  report("ready", 290)
  await until("the harness's turn to be kept", () => (owner.snapshot(id)?.harnessTurns?.length ?? 0) === 1)
  const own = owner.snapshot(id)!.harnessTurns![0]!
  assert.equal(own.kind, "turn")
  assert.deepEqual(own.spend.tokens, tokens(60), "what the subagent spent before it, and the turn itself")
  assert.equal(own.spend.model, "composer-2")

  // Work after the last turn, then the process goes: kept as `after`, and its meter is counted no more.
  report("ready", 310)
  report("ready", 310, { connection: "disconnected" })
  await until("the spend after the last turn", () => (owner.snapshot(id)?.harnessTurns?.length ?? 0) === 2)
  const after = owner.snapshot(id)!.harnessTurns![1]!
  assert.equal(after.kind, "after")
  assert.deepEqual(after.spend.tokens, tokens(20))
  assert.equal(owner.snapshot(id)!.spentThrough, undefined, "a gone process's meter counts nothing more")
  const whole = spendOf(owner.snapshot(id)!)
  assert.equal(whole.tokens?.input, 210, "the conversation's spend is every token its process's meter read")
  assert.equal(whole.turns, 4, "two turns Mako sent, one the harness ran, and what came after")
  await owner.close(id)

  // Reopened, the conversation sums the same, from its own journal.
  const journal = new LiveJournal(conversations, id)
  const read = journal.read()
  journal.close()
  assert.equal(read?.harnessTurns?.length, 2, "the harness's turns are kept in the journal")
  assert.equal(read && spendOf(read).tokens?.input, 210)

  // Settings › Usage counts them for a harness whose store keeps no counts.
  const measured = usageHarnesses(providerHost).map((harness) => harness.provider === "cursor" ? { provider: harness.provider, label: harness.label } : harness)
  const summary = await usageSummary(measured, join(root, "no-sessions"), join(root, "home"), conversations)
  const cursor = summary.sources?.find((source) => source.source === "Cursor")
  assert.equal(cursor?.input, 210, "every turn's spend, the harness's own included")
  assert.equal(cursor?.messages, 4)
  console.log("Turn spend: spend between turns counts in the next, a turn the harness runs is kept with its spend, spend after the last turn is kept when the process goes, and the panel, the journal and Settings › Usage sum every token the meter read")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
  process.exit()
}

import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { SessionSettings } from "@mako/sessions/settings"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import type { WorkspaceSnapshot } from "@mako/host/contracts/workspace-snapshots"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * A Thread at work keeps going without a click (`npm run test:thread-stays-live`).
 *
 * On 2026-11-11 the person's message into their Apex's running Claude turn stopped the turn to go as the next message
 * (a steer's `restart` landing). Claude Code ends its process on Stop, so the host woke the session again, and the
 * message sat queued for 15 minutes, until their next message happened to drain the queue. A turn's end captures the
 * workspace's after-snapshot (`LiveCheckpoints.settle`), which on a project folder of 12,661 files took longer than
 * the wake; the drain the wake made waited for it (`checkpointing`), and the snapshot's own drain was skipped because
 * the wake had moved the conversation's generation on.
 *
 * Here Claude's stop ends its process too, and the after-snapshot finishes only once the session is awake again. The
 * person's message must reach the agent with nothing else happening: no click, no other message.
 *
 * And a turn continued after a crash runs on the model its session runs on. The person's Fin began on Cursor, whose
 * model IDs carry its options (`claude-opus-5-5[cyber=false,context=1m,…]`), and moved to Claude Code; continued after
 * Mako closed, its turn went with Cursor's ID, which Claude refused on that turn and every one after.
 */
const root = testScratch("mako-thread-stays-live-")
const cwd = join(root, "workspace")
mkdirSync(cwd)
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
git("init", "-q")
git("config", "user.name", "Test")
git("config", "user.email", "test@localhost")
writeFileSync(join(cwd, "answer"), "initial")
git("add", ".")
git("commit", "-qm", "initial")

/** The workspace's snapshots, the after-snapshot of a turn's end held until `release`: a big project folder's. */
class SlowAfter extends WorkspaceSnapshots {
  readonly held: string[] = []
  private readonly gate = Promise.withResolvers<void>()
  release(): void {
    this.gate.resolve()
  }
  override async endRun(id: string): Promise<WorkspaceSnapshot> {
    this.held.push(id)
    await this.gate.promise
    return super.endRun(id)
  }
}
const snapshots = new SlowAfter(new Git(), join(root, "snapshots"))

const prompts: string[] = []
const starts: string[] = []
let state: LiveSessionState
let owner: LiveConversations
const driver: ProviderLiveDriver = {
  ...noCapabilities,
  resume: fixtureResume(),
  // As Claude Code's: the person's steer stops the turn and goes as the next message.
  steering: { kind: "supported", lands: "step", landing: "restart", via: "Claude-like fixture", steer: async () => ({ kind: "accepted" }) },
  approvalEvidence: { kind: "submission-only", reason: "Claude-like fixture" },
  launchEnvironment: { kind: "unavailable", reason: "Claude-like fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Claude-like fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  planning: { via: "setting", option: "plan", proposal: "Claude-like fixture", feedback: { kind: "next-message", reason: "Claude-like fixture" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "Claude-like fixture" },
  turnRecovery: { kind: "manual", reason: "Claude-like fixture" },
  provider: "claude",
  available: () => true,
  async start(where, options) {
    starts.push(options.resume ?? "new")
    state = { id: options.conversationId, harness: "claude", cwd: where, nativeId: "native-1", nativePath: join(root, "native-1.jsonl"), status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
    return state
  },
  async prompt(_id, text, _attachments, _settings, dispatch) {
    dispatch.report({ kind: "submitted", source: "transport-call" })
    prompts.push(text)
    state = { ...state, status: "running", nativeRunId: randomUUID() }
    owner.observe({ type: "live-session", session: state })
  },
  // As Claude Code's: Stop interrupts the turn, then ends the process; the next message resumes the session.
  async cancel() {
    await delay(20)
    state = { ...state, status: "ready", connection: "disconnected", lastStop: "interrupted" }
    owner.observe({ type: "live-session", session: state })
  },
  async permission() {},
  async setMode() {},
  close() {},
}
owner = new LiveConversations({
  root: join(root, "conversations"), appPath: root, driver: () => driver, history: async () => null, emit: () => {},
  workspaceSnapshots: snapshots,
  resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
})

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await delay(10)
  }
}

/** A turn continued after a crash, on a conversation that began on a Cursor-like harness and moved to a Claude-like one. */
async function continuedAfterMove(catalog: boolean, poisoned: boolean): Promise<SessionSettings | undefined> {
  const sessions = new Map<string, LiveSessionState>()
  const emits = new Map<string, (event: { type: "live-session"; session: LiveSessionState }) => void>()
  const sent: { provider: string; session: string; settings: SessionSettings | undefined }[] = []
  let world: LiveConversations
  const harness = (provider: string): ProviderLiveDriver => ({
    ...driver,
    provider,
    steering: { kind: "unavailable", reason: "fixture" },
    async start(where, options) {
      const session: LiveSessionState = { id: options.conversationId, harness: provider, cwd: where, nativeId: `native-${provider}-${options.conversationId}`, nativePath: join(root, `${provider}-${options.conversationId}.jsonl`), status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [], ...options.tuning && { settings: options.tuning } }
      sessions.set(options.conversationId, session)
      if (options.emit) emits.set(options.conversationId, options.emit)
      return session
    },
    async prompt(sessionId, _text, _attachments, settings, dispatch) {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      sent.push({ provider, session: sessionId, settings })
      const running: LiveSessionState = { ...sessions.get(sessionId)!, status: "running", nativeRunId: randomUUID() }
      sessions.set(sessionId, running)
      emits.get(sessionId)?.({ type: "live-session", session: running })
    },
  })
  const harnesses = new Map(["cursor", "claude"].map((provider) => [provider, harness(provider)]))
  // The last prompted session's turn ends.
  const finish = () => {
    const sessionId = sent.at(-1)!.session
    const ready: LiveSessionState = { ...sessions.get(sessionId)!, status: "ready", lastStop: "end_turn" }
    sessions.set(sessionId, ready)
    emits.get(sessionId)?.({ type: "live-session", session: ready })
  }
  world = new LiveConversations({
    root: join(root, `moved-${catalog}-${poisoned}`), appPath: root, driver: (provider) => harnesses.get(provider), emit: () => {},
    history: async () => null,
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    ...catalog && { heldModels: (provider) => (provider === "claude" ? [{ id: "claude-opus-5-5", label: "Opus 5.5", options: [] }] : undefined) },
  })
  const id = randomUUID()
  const cursorModel: SessionSettings = { model: "claude-opus-5-5[cyber=false,context=1m,effort=medium,fast=false]", options: { plan: false } }
  await world.start("cursor", cwd, { conversationId: id, tuning: cursorModel })
  await until("the Cursor session", () => world.snapshot(id)?.session.connection === "connected")
  world.submit(id, randomUUID(), "build the importer", [], cursorModel)
  await until("the Cursor turn", () => sent.length === 1)
  finish()
  await until("the Cursor turn's end", () => world.snapshot(id)?.session.status === "ready")
  // Moved to Claude Code on its own model.
  world.transfer(id, { id: randomUUID(), provider: "claude", text: "carry on", attachments: [], tuning: { model: "claude-opus-5-5" } })
  await until("the move's first turn on Claude", () => sent.length === 2 && sent[1]!.provider === "claude")
  finish()
  await until("that turn's end", () => world.snapshot(id)?.session.status === "ready" && !world.snapshot(id)?.requests.some((request) => request.status === "dispatching"))
  const cut = randomUUID()
  world.submit(id, cut, "and then the tests")
  await until("a turn on Claude with no tuning of its own", () => sent.length === 3)
  finish()
  await until("its end", () => world.snapshot(id)?.session.status === "ready" && !world.snapshot(id)?.requests.some((request) => request.status === "dispatching"))
  if (poisoned) {
    // A build before this one carried Cursor's ID to the Claude session, and its binding kept it.
    const binding = world.snapshot(id)!.control!.bindings.find((candidate) => candidate.provider === "claude")!
    Object.assign(binding, { tuning: cursorModel })
  }
  world.continueTurn(id, { requestId: randomUUID(), reason: "host-crashed", continues: cut, actor: { kind: "service", name: "auto-continue" } })
  await until("the continued turn", () => sent.length === 4)
  world.stop()
  assert.equal(sent[3]!.provider, "claude")
  return sent[3]!.settings
}

try {
  {
    const settings = await continuedAfterMove(false, false)
    assert.notEqual(settings?.model, "claude-opus-5-5[cyber=false,context=1m,effort=medium,fast=false]", "a turn continued on Claude never carries Cursor's model ID")
    assert.equal(settings?.model ?? "claude-opus-5-5", "claude-opus-5-5", "it runs on the model its Claude session runs on")
    const healed = await continuedAfterMove(true, true)
    assert.notEqual(healed?.model, "claude-opus-5-5[cyber=false,context=1m,effort=medium,fast=false]", "a binding that kept Cursor's ID isn't carried on: Claude's catalog doesn't offer it")
    console.log("thread stays live: a turn continued after a move and a crash runs on its session's own model, never another harness's ID")
  }
  const id = randomUUID(), first = randomUUID()
  await owner.start("claude", cwd, { conversationId: id })
  await until("the session to connect", () => owner.snapshot(id)?.session.connection === "connected")
  owner.submit(id, first, "build the importer")
  await until("the first turn to run", () => owner.snapshot(id)?.requests.find((request) => request.id === first)?.nativeRun !== undefined)

  // The person's message into the running turn, as the composer sends it: queued, then steered.
  const words = "stop, use the existing parser"
  const queued = randomUUID()
  owner.submit(id, queued, words)
  const receipt = await owner.act(id, { kind: "steer-queued", id: randomUUID(), requestId: first, queuedRequestId: queued, text: words, attachments: [] })
  assert.equal(receipt.state.kind, "accepted")

  // The stop ended the process; the session is woken again while the stopped turn's after-snapshot still runs.
  await until("the stopped turn's after-snapshot to begin", () => snapshots.held.includes(first))
  await until("the session to be woken again", () => starts.length === 2 && owner.snapshot(id)?.session.connection === "connected")
  assert.equal(prompts.length, 1, "nothing goes while the after-snapshot runs")
  snapshots.release()

  // Nothing else happens: no click, no other message.
  await until("the person's message to reach the agent with nothing else happening", () => prompts.length === 2)
  assert.ok(prompts[1]!.endsWith(words), "the agent hears the person's message")
  const requests = owner.snapshot(id)!.requests
  assert.equal(requests.find((request) => request.id === first)?.interruption?.reason, "steered")
  assert.equal(requests.find((request) => request.id === queued)?.status, "dispatching")
  await until("the stopped turn's after-snapshot to be kept", () => owner.snapshot(id)?.requests.find((request) => request.id === first)?.snapshots?.after?.kind === "ready")
  console.log("thread stays live: a steer that stopped Claude's turn reaches the agent once its after-snapshot ends, with no click")
} finally {
  snapshots.release()
  owner.stop()
}

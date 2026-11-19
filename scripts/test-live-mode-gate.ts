import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

/**
 * No message starts a turn while an access change is on its way to the harness (`LiveConversations.setMode`,
 * `Resident.modeChanging`): the host holds the line for every client, whatever its window shows. A fake driver holds
 * its `setMode` open; a message that arrives meanwhile is admitted and saved but not sent, and goes the moment the
 * harness answers, taken or refused, after it and never before. A change on a hibernated session is recorded for its
 * next launch and asks no driver anything.
 *
 *   npx tsx scripts/test-live-mode-gate.ts
 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const root = mkdtempSync(join(tmpdir(), "mako-mode-gate-"))
const id = randomUUID()
/** What the driver was asked, in order. */
const asked: string[] = []
const open: { take: () => void; refuse: (why: string) => void }[] = []
let emit: (event: LiveDriverEvent) => void = () => {}
let state: LiveSessionState
const MODES = [{ id: "ask", name: "Ask", access: "ask" as const }, { id: "full", name: "Full", access: "full" as const }]
const driver: ProviderLiveDriver = {
  ...noCapabilities,
  resume: fixtureResume(),
  launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: { kind: "accepted-message-id", evidence: "Injected driver fixture" },
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
  turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
  provider: "mode-gate-fixture",
  available: () => true,
  async start(cwd, options) {
    emit = options.emit ?? (() => {})
    state = {
      id: options.conversationId, nativeId: "fixture-native", nativePath: join(root, "native-history"), harness: "mode-gate-fixture", cwd,
      status: "ready", connection: "connected", modes: MODES, currentMode: options.modeId ?? "full", configOptions: [],
    }
    return state
  },
  async prompt(_id, text, _attachments, _settings, dispatch) {
    asked.push(`prompt ${text} under ${state.currentMode}`)
    dispatch.report({ kind: "submitted", source: "transport-call" })
    state = { ...state, status: "running", nativeRunId: randomUUID() }
    emit({ type: "live-session", session: state })
  },
  async permission() {},
  async cancel() {},
  close() {},
  setMode: (_id, mode) => new Promise<void>((resolve, reject) => {
    asked.push(`mode ${mode}`)
    open.push({
      take: () => {
        state = { ...state, currentMode: mode }
        emit({ type: "live-session", session: state })
        asked.push(`mode ${mode} taken`)
        resolve()
      },
      refuse: (why) => { asked.push(`mode ${mode} refused`); reject(new Error(why)) },
    })
  }),
}
/** Ends the running turn, as the harness says it. */
function endTurn(): void {
  state = { ...state, status: "ready", lastStop: "completed" }
  emit({ type: "live-session", session: state })
}

const owner = new LiveConversations({ root, appPath: root, driver: () => driver, history: async () => null, emit: () => {} })
try {
  await owner.start("mode-gate-fixture", root, { conversationId: id, modeId: "full" })
  await tick()

  // A change to a narrower level on its way: the message behind it waits, and goes under the narrower level.
  const narrowing = owner.setMode(id, "ask")
  await tick()
  owner.submit(id, randomUUID(), "behind the narrowing")
  await tick()
  await tick()
  assert.deepEqual(asked, ["mode ask"], "the message is not sent while the harness hasn't answered the change")
  assert.equal(owner.snapshot(id)?.requests.at(-1)?.status, "queued", "it is admitted and saved, and waits")
  open.shift()!.take()
  await narrowing
  await tick()
  assert.deepEqual(asked, ["mode ask", "mode ask taken", "prompt behind the narrowing under ask"], "it goes once the change is taken, under the level chosen")
  endTurn()
  await tick()

  // A refused change lets it go too, under the level the session kept: the wait is for the answer, whichever it is.
  asked.length = 0
  const refused = owner.setMode(id, "full")
  await tick()
  owner.submit(id, randomUUID(), "behind a refusal")
  await tick()
  assert.deepEqual(asked, ["mode full"])
  open.shift()!.refuse("Full access is set when a session starts.")
  await assert.rejects(refused, /set when a session starts/, "the change's caller hears the refusal")
  await tick()
  assert.deepEqual(asked, ["mode full", "mode full refused", "prompt behind a refusal under ask"], "under the narrower level the session kept")
  endTurn()
  await tick()

  // Two changes on their way: nothing goes until both are answered.
  asked.length = 0
  const one = owner.setMode(id, "full")
  const two = owner.setMode(id, "ask")
  await tick()
  owner.submit(id, randomUUID(), "behind two")
  await tick()
  open.shift()!.take()
  await one
  await tick()
  assert.equal(asked.some((each) => each.startsWith("prompt")), false, "one answered of two: the message still waits")
  open.shift()!.take()
  await two
  await tick()
  assert.equal(asked.at(-1), "prompt behind two under ask")
  endTurn()
  await tick()

  // With no change on its way a message goes at once, as before.
  asked.length = 0
  owner.submit(id, randomUUID(), "nothing ahead")
  await tick()
  assert.deepEqual(asked, ["prompt nothing ahead under ask"])
  endTurn()
  await tick()

  // A hibernated session records the change for its next launch: no process is woken for it, and no driver is asked.
  assert.equal(owner.hibernateIfIdle(id), true, "the idle session hibernates")
  for (const deadline = Date.now() + 5_000; owner.snapshot(id)?.session.connection !== "hibernated"; await tick())
    if (Date.now() > deadline) throw new Error(`the session never hibernated (${owner.snapshot(id)?.session.connection})`)
  asked.length = 0
  await owner.setMode(id, "full")
  await tick()
  assert.deepEqual(asked, [], "nothing is asked of the driver")
  assert.equal(owner.snapshot(id)?.session.connection, "hibernated", "and the session still sleeps")
  assert.equal(owner.snapshot(id)?.session.currentMode, "full", "its next launch starts in the mode recorded")
  console.log("PASS: A message behind an access change waits for the harness's answer, and a sleeping session isn't woken for one")
} finally {
  await owner.stop()
  rmSync(root, { recursive: true, force: true })
}

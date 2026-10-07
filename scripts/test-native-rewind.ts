import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { ThreadPage } from "@mako/sessions"
import { LiveConversations } from "../electron/live-conversations.js"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import { NO_NATIVE_EXCLUSION } from "../electron/contracts/execution-context.js"
import { NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity.js"
import { projectLive } from "../src/state/live-projection.ts"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// A harness that reverts its own history (OpenCode's `session.revert.*`, from
// Mako or another client of the shared service) says so live. The live blocks
// still hold the dropped turn; the host draws the store's history instead.
const root = mkdtempSync(join(tmpdir(), "mako-native-rewind-"))
const waitFor = async (check: () => boolean, message: string) => {
  for (let i = 0; i < 400 && !check(); i++) await delay(5)
  assert.ok(check(), message)
}
try {
  const id = randomUUID()
  const nativePath = join(root, "native-rewind")
  let emit: ((event: LiveDriverEvent) => void) | undefined
  let turns = 0
  const answers = ["The release ships on Friday.", "QA signs off on Thursday."]
  const session = (bindingId: string, status: LiveSessionState["status"] = "ready", nativeRunId?: string): LiveSessionState => ({
    id: bindingId, nativeId: "native-rewind", nativePath, harness: "test-provider", cwd: root,
    status, connection: "connected", modes: [], currentMode: null, configOptions: [], nativeRunId,
  })
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    resume: fixtureResume(),
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture" },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider: "test-provider", available: () => true,
    start: async (_cwd, options) => {
      emit = options.emit
      return session(options.conversationId)
    },
    prompt: async (bindingId) => {
      const turn = turns++
      emit?.({ type: "live-session", session: session(bindingId, "running", `run-${turn}`) })
      emit?.({ type: "live-update", id: bindingId, update: { kind: "text", text: answers[turn] ?? "" } })
      emit?.({ type: "live-session", session: session(bindingId) })
    },
    permission: async () => {}, cancel: async () => {}, close: async () => {}, setMode: async () => {},
  }
  const prompts = ["Which day does the release ship?", "Which day does QA sign off?"]
  const turn = (index: number): ThreadPage["entries"] => [
    { kind: "user", id: `u${index}`, text: prompts[index]! },
    { kind: "assistant", id: `a${index}`, blocks: [{ type: "text", text: answers[index]! }] },
  ]
  let store = { revision: 1, entries: [...turn(0), ...turn(1)] }
  let reads = 0
  const owner = new LiveConversations({
    appPath: root, root: join(root, "journals"), driver: () => driver, emit: () => {},
    checkpoint: async () => `checkpoint-${store.revision}`,
    history: async () => {
      reads++
      return {
        ref: { harness: "test-provider", nativeId: "native-rewind", path: nativePath, bytes: store.revision },
        entries: store.entries, start: 0, total: store.entries.length, hasEarlier: false, checkpoint: store.revision,
      }
    },
  })
  try {
    await owner.start("test-provider", root, { conversationId: id })
    for (const [index, text] of prompts.entries()) {
      owner.submit(id, randomUUID(), text)
      await waitFor(() => owner.snapshot(id)?.requests[index]?.status === "completed", `turn ${index} did not complete`)
    }
    const covered = () => owner.snapshot(id)?.control?.bindings[0]?.coveredBlocks
    await waitFor(() => covered() === owner.snapshot(id)?.blocks.length, "the finished turns were not checkpointed")
    const drawn = () => projectLive(owner.snapshot(id)!).messages.map((message) =>
      message.blocks.map((block) => block.type === "text" ? `${message.role}: ${block.text}` : block.type).join(" "))
    assert.deepEqual(drawn(), [`user: ${prompts[0]}`, `assistant: ${answers[0]}`, `user: ${prompts[1]}`, `assistant: ${answers[1]}`])
    const before = owner.snapshot(id)!
    assert.equal(before.requests[1]?.nativeRun?.runId, "run-1", "the second turn knows its native run")

    store = { revision: 2, entries: turn(0) }
    const readsBefore = reads
    emit?.({ type: "live-rewound", id: before.control!.activeBindingId!, run: "run-1" })
    await waitFor(() => owner.snapshot(id)?.base?.entries.length === 2, "the rewind did not read the store back")
    const after = owner.snapshot(id)!
    assert.ok(reads > readsBefore, "the rewind reads the store")
    assert.equal(after.baseCoveredBlocks, before.blocks.length, "the store's history covers every live block")
    assert.deepEqual(after.blocks, before.blocks, "the live record itself is kept")
    assert.deepEqual(drawn(), [`user: ${prompts[0]}`, `assistant: ${answers[0]}`], "the reverted turn is no longer drawn")

    const next = "How many lines does notes.md have?"
    answers.push("notes.md has two lines.")
    owner.submit(id, randomUUID(), next)
    await waitFor(() => owner.snapshot(id)?.requests[2]?.status === "completed", "the turn after the rewind did not complete")
    assert.deepEqual(drawn(), [`user: ${prompts[0]}`, `assistant: ${answers[0]}`, `user: ${next}`, `assistant: ${answers[2]}`],
      "the next turn follows the store's history")
  } finally {
    owner.close(id)
  }
  console.log("Native rewind: a harness's own revert redraws from its store, keeps the live record, and the next turn follows it")
} finally {
  rmSync(root, { recursive: true, force: true })
}

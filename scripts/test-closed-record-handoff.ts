import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "../electron/live-conversations.ts"
import type { ResumeVerdict } from "../electron/contracts/conversation-control.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import { NO_NATIVE_EXCLUSION } from "../electron/contracts/execution-context.ts"
import { NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity.ts"
import type { LiveSessionState } from "../electron/shared.ts"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// A record its harness keeps closed (a Codex archive, a Cursor desktop chat)
// continues in a new session of the same harness carrying the conversation,
// and the record is never reopened. Any other record that won't reopen still
// refuses rather than quietly starting over.
const root = mkdtempSync(join(tmpdir(), "mako-closed-handoff-"))
const starts: Array<string | undefined> = []
const driver: ProviderLiveDriver = {
  ...noCapabilities,
  resume: fixtureResume(),
  launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  planning: { via: "setting", option: "plan", proposal: "Injected driver fixture" },
  backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
  turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
  provider: "codex",
  available: () => true,
  async start(cwd, options) {
    starts.push(options.resume)
    const session: LiveSessionState = {
      id: options.conversationId,
      nativeId: `fresh-${options.conversationId}`,
      harness: "codex",
      cwd,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    }
    return session
  },
  async prompt() {},
  async cancel() {},
  async permission() {},
  async setMode() {},
  async close() {},
}
let verdict: ResumeVerdict = { kind: "closed", reason: "Codex keeps archived chats closed." }
const owner = new LiveConversations({
  root,
  appPath: root,
  driver: () => driver,
  emit: () => {},
  history: async (path) => ({
    ref: { harness: "codex", nativeId: `archived-${path}`, path, cwd: root, title: "Archived chat" },
    entries: [
      { kind: "user", text: "Plan the parser" },
      { kind: "assistant", blocks: [{ type: "text", text: "Keep the recursive descent parser" }] },
    ],
    start: 0,
    total: 2,
    hasEarlier: false,
  }),
  resumeVerdict: async () => verdict,
})

async function settled(id: string, transferId: string) {
  const deadline = Date.now() + 5_000
  for (;;) {
    const transfer = owner.snapshot(id)?.control?.transfers.find((item) => item.input.id === transferId)
    if (transfer && transfer.state.kind !== "queued" && transfer.state.kind !== "preparing") return transfer.state
    if (Date.now() > deadline) throw new Error("Timed out waiting for the transfer")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

try {
  const closed = randomUUID()
  const closedPath = join(root, "archived_sessions", "rollout-closed.jsonl")
  await owner.capture(closed, closedPath)
  const original = owner.snapshot(closed)?.control?.activeBindingId
  const reply = randomUUID()
  owner.transfer(closed, { id: reply, provider: "codex", text: "Now write it", attachments: [] })
  const state = await settled(closed, reply)
  assert.equal(state.kind, "accepted", JSON.stringify(state))
  assert.deepEqual(starts, [undefined], "the closed record is never resumed")
  if (state.kind === "accepted") {
    assert.notEqual(state.bindingId, original, "the reply runs on a new binding")
    assert.equal(state.manifest.includesBase, true, "the new session gets the whole conversation")
    assert.equal(state.manifest.fromBlock, 0)
  }
  const control = owner.snapshot(closed)?.control
  assert.equal(control?.bindings.length, 2, "the closed record stays in the conversation")
  assert.equal(control?.bindings.find((binding) => binding.id === original)?.path, closedPath)

  verdict = { kind: "unavailable", reason: "The native record is missing or changed while it was being read." }
  const missing = randomUUID()
  await owner.capture(missing, join(root, "sessions", "rollout-missing.jsonl"))
  const refused = randomUUID()
  owner.transfer(missing, { id: refused, provider: "codex", text: "Go on", attachments: [] })
  const refusal = await settled(missing, refused)
  assert.equal(refusal.kind, "failed")
  if (refusal.kind === "failed") assert.match(refusal.error, /cannot be resumed.*No replacement session was started/)
  assert.equal(starts.length, 1, "a record that is merely unreadable starts nothing")
  console.log("Closed records: a reply to one its harness keeps closed continues in a new session with the whole conversation; an unreadable record still refuses")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
  process.exit()
}

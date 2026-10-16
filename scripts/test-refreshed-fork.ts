import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { ThreadPage } from "@mako/sessions"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { LiveDriverEvent, LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// Once a conversation is idle, the host reads its harness's store back and
// draws the live turns from it. A fork or rewind of an earlier live turn then
// starts from the store's history before the live turns and goes on with the
// live record up to that turn, whether or not the host restarted between.
const root = mkdtempSync(join(tmpdir(), "mako-refreshed-fork-"))
const waitFor = async (check: () => boolean, message: string) => {
  for (let i = 0; i < 400 && !check(); i++) await delay(5)
  assert.ok(check(), message)
}
const turn = (id: string, prompt: string, answer: string): ThreadPage["entries"] => [
  { type: "user", id: `u-${id}`, text: prompt },
  { type: "text", id: `a-${id}`, text: answer },
]
const said = (entries: ThreadPage["entries"]) => entries.map((entry) =>
  entry.type === "user" ? `user: ${entry.text}` : entry.type === "text" ? `assistant: ${entry.text}` : entry.type)
try {
  const nativeId = "native-refreshed"
  const nativePath = join(root, nativeId)
  const prompts = ["Which day does the release ship?", "Which day does QA sign off?"]
  const answers = ["The release ships on Friday.", "QA signs off on Thursday."]
  const store = { revision: 1, entries: turn("saved", "Where are the release notes?", "In notes.md.") }
  let emit: ((event: LiveDriverEvent) => void) | undefined
  let turns = 0
  const session = (bindingId: string, status: LiveSessionState["status"] = "ready", nativeRunId?: string): LiveSessionState => ({
    id: bindingId, nativeId, nativePath, harness: "test-provider", cwd: root,
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
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider: "test-provider", available: () => true,
    start: async (_cwd, options) => {
      emit = options.emit
      return session(options.conversationId)
    },
    prompt: async (bindingId) => {
      const index = turns++
      emit?.({ type: "live-session", session: session(bindingId, "running", `run-${index}`) })
      emit?.({ type: "live-update", id: bindingId, update: { kind: "text", text: answers[index]! } })
      store.entries = [...store.entries, ...turn(`${index}`, prompts[index]!, answers[index]!)]
      store.revision++
      emit?.({ type: "live-session", session: session(bindingId) })
    },
    permission: async () => {}, cancel: async () => {}, close: async () => {}, setMode: async () => {},
  }
  const host = () => new LiveConversations({
    appPath: root, root: join(root, "journals"), driver: () => driver, emit: () => {},
    checkpoint: async () => `checkpoint-${store.revision}`,
    history: async () => ({
      ref: { harness: "test-provider", nativeId, path: nativePath, bytes: store.revision },
      entries: store.entries, start: 0, total: store.entries.length, hasEarlier: false, checkpoint: store.revision,
    }),
  })
  const id = randomUUID()
  const saved = ["user: Where are the release notes?", "assistant: In notes.md."]
  const first = [`user: ${prompts[0]}`, `assistant: ${answers[0]}`]
  const second = [`user: ${prompts[1]}`, `assistant: ${answers[1]}`]
  const forked = (owner: LiveConversations, point: { kind: "run" | "before-run"; requestId: string }) =>
    said(owner.fork(id, { id: randomUUID(), provider: "test-provider", point }).base?.entries ?? [])

  const owner = host()
  let source: LiveSnapshot
  try {
    await owner.start("test-provider", root, { conversationId: id, threadPath: nativePath, resume: nativeId })
    for (const [index, text] of prompts.entries()) {
      owner.submit(id, randomUUID(), text)
      await waitFor(() => owner.snapshot(id)?.requests[index]?.status === "completed", `turn ${index} did not complete`)
    }
    const covered = () => owner.snapshot(id)?.control?.bindings[0]?.coveredBlocks
    await waitFor(() => covered() === owner.snapshot(id)?.blocks.length, "the finished turns were not checkpointed")
    source = (await owner.refreshedSnapshot(id))!
    assert.equal(source.baseCoveredBlocks, source.blocks.length, "the store's history covers every live block")
    assert.deepEqual(said(source.base!.entries), [...saved, ...first, ...second], "the store's history holds the saved turn and both live turns")
    assert.equal(source.baseLiveStart, 2, "the live turns begin after the saved turn")

    const [earlier, later] = source.requests.map((request) => request.id)
    assert.deepEqual(forked(owner, { kind: "run", requestId: earlier! }), [...saved, ...first], "a fork after the earlier answer ends there")
    assert.deepEqual(forked(owner, { kind: "before-run", requestId: later! }), [...saved, ...first], "a rewind to before the later prompt ends at the earlier answer")
    assert.deepEqual(forked(owner, { kind: "before-run", requestId: earlier! }), saved, "a rewind to before the first live prompt keeps only the saved history")
    assert.deepEqual(forked(owner, { kind: "run", requestId: later! }), [...saved, ...first, ...second], "a fork after the last answer is the store's whole history")
  } finally {
    owner.close(id)
  }

  const restarted = host()
  try {
    assert.equal(restarted.snapshot(id)?.baseLiveStart ?? (await restarted.refreshedSnapshot(id))?.baseLiveStart, 2, "the journal keeps where the live turns begin")
    assert.deepEqual(forked(restarted, { kind: "run", requestId: source.requests[0]!.id }), [...saved, ...first], "a restarted host forks the earlier answer the same way")
  } finally {
    restarted.close(id)
  }
  console.log("Refreshed forks: an earlier live turn forks and rewinds from the store's history before the live turns, before and after a restart")
} finally {
  rmSync(root, { recursive: true, force: true })
}

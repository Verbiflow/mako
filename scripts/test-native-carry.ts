import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EmitResult, Thread, ThreadRef } from "@mako/sessions"
import { LiveConversations } from "../electron/live-conversations.ts"
import { nativeSessionPath } from "../electron/native-source.ts"
import type { TransferInput } from "../electron/contracts/conversation-control.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import { NO_NATIVE_EXCLUSION } from "../electron/contracts/execution-context.ts"
import { NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity.ts"
import type { LiveSessionState } from "../electron/shared.ts"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// Moving a conversation to a harness that opens a new session can carry the
// history natively: written into that harness's own store and resumed there.
// Anything short of a confirmed resume of that exact session goes as
// transcript, and says why.
const root = mkdtempSync(join(tmpdir(), "mako-native-carry-"))
const starts: Array<string | undefined> = []
let refuseResume = false
let wrongSession = false
let reportThroughAccount = false
const catalog: ThreadRef[] = []
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
  provider: "grok",
  available: () => true,
  async start(cwd, options) {
    starts.push(options.resume)
    if (options.resume && refuseResume) throw new Error("no such session")
    const nativeId = options.resume && !wrongSession ? options.resume : `fresh-${options.conversationId}`
    const session: LiveSessionState = {
      id: options.conversationId,
      nativeId,
      harness: "grok",
      cwd,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    }
    if (reportThroughAccount) {
      writeFileSync(join(root, "account", `${nativeId}.json`), "{}")
      session.nativePath = join(root, "account", `${nativeId}.json`)
      catalog.push({ harness: "grok", nativeId, path: realpathSync(session.nativePath) })
    }
    return session
  },
  async prompt() {},
  async cancel() {},
  async permission() {},
  async setMode() {},
  async close() {},
}
// The account's store reaches the shared one through a symlink, as Claude's
// CLAUDE_CONFIG_DIR profiles do; the session index knows the real path.
mkdirSync(join(root, "store"))
symlinkSync(join(root, "store"), join(root, "account"))
const emitted: Thread[] = []
let emitter: ((thread: Thread) => Promise<EmitResult | null>) | undefined = async (thread) => {
  emitted.push(thread)
  const path = join(root, "account", `imported-${emitted.length}.json`)
  writeFileSync(path, "{}")
  return { sessionId: `imported-${emitted.length}`, path }
}
const owner = new LiveConversations({
  root,
  appPath: root,
  driver: () => driver,
  emit: () => {},
  emitSession: async (_provider, thread) => (emitter ? emitter(thread) : null),
  nativePath: (session) => nativeSessionPath(session, catalog),
  history: async (path) => ({
    ref: { harness: "claude", nativeId: `source-${path}`, path, cwd: "/elsewhere", title: "Parser work" },
    entries: [
      { kind: "user", text: "Plan the parser" },
      { kind: "assistant", blocks: [{ type: "text", text: "Keep the recursive descent parser" }] },
    ],
    start: 0,
    total: 2,
    hasEarlier: false,
  }),
  resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
})

async function move(carry: TransferInput["carry"]) {
  const id = randomUUID()
  await owner.capture(id, join(root, "claude", `${id}.jsonl`))
  const transferId = randomUUID()
  owner.transfer(id, { id: transferId, provider: "grok", text: "Now write it", attachments: [], carry })
  const deadline = Date.now() + 5_000
  for (;;) {
    const snapshot = owner.snapshot(id)
    const transfer = snapshot?.control?.transfers.find((item) => item.input.id === transferId)
    if (transfer && transfer.state.kind !== "queued" && transfer.state.kind !== "preparing") {
      assert.equal(transfer.state.kind, "accepted", JSON.stringify(transfer.state))
      if (transfer.state.kind !== "accepted") throw new Error("unreachable")
      const state = transfer.state
      const request = snapshot!.requests.find((item) => item.id === transferId)
      const binding = snapshot!.control!.bindings.find((item) => item.id === state.bindingId)
      return { state, request, binding, cwd: snapshot!.session.cwd }
    }
    if (Date.now() > deadline) throw new Error("Timed out waiting for the transfer")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

try {
  const native = await move("native")
  assert.deepEqual(starts, ["imported-1"], "the destination resumes the session written for it")
  assert.equal(native.state.carried, "native")
  assert.equal(native.state.fallback, undefined)
  assert.deepEqual(native.request?.context, [], "no transcript rides along with a native carry")
  assert.equal(native.binding?.nativeId, "imported-1")
  assert.equal(native.binding?.path, realpathSync(join(root, "store", "imported-1.json")),
    "the binding names the imported file by the real path the session index knows")
  assert.equal(emitted[0]?.ref.cwd, native.cwd, "the session is written where the destination opens it")
  assert.match(JSON.stringify(emitted[0]?.entries), /Plan the parser.*Keep the recursive descent parser/)

  starts.length = 0
  const transcript = await move("transcript")
  assert.equal(emitted.length, 1, "transcript replay writes no native session")
  assert.deepEqual(starts, [undefined])
  assert.equal(transcript.state.carried, "transcript")
  assert.equal(transcript.request?.context?.length, 1)

  reportThroughAccount = true
  const throughAccount = await move("transcript")
  assert.equal(throughAccount.binding?.path, realpathSync(join(root, "store", `${throughAccount.binding?.nativeId}.json`)),
    "a driver naming its file through the account's store binds the path the catalog lists")
  reportThroughAccount = false

  starts.length = 0
  refuseResume = true
  const refused = await move("native")
  assert.deepEqual(starts, ["imported-2", undefined], "a refused resume opens a new session instead")
  assert.equal(refused.state.carried, "transcript")
  assert.match(refused.state.fallback ?? "", /did not resume the imported session: no such session/)
  assert.equal(refused.request?.context?.length, 1, "the transcript carries the history instead")
  refuseResume = false

  starts.length = 0
  wrongSession = true
  const swapped = await move("native")
  assert.deepEqual(starts, ["imported-3", undefined])
  assert.match(swapped.state.fallback ?? "", /opened a different session/)
  assert.equal(swapped.request?.context?.length, 1)
  wrongSession = false

  starts.length = 0
  const parent = randomUUID()
  await owner.capture(parent, join(root, "claude", `${parent}.jsonl`))
  const forkId = randomUUID()
  owner.fork(parent, { id: forkId, provider: "grok", point: { kind: "native", index: 1, revision: "[null,null,null]" } })
  const forkRequest = randomUUID()
  owner.submit(forkId, forkRequest, "Try another parser")
  const deadline = Date.now() + 5_000
  while (owner.snapshot(forkId)?.control?.transfers.at(-1)?.state.kind !== "accepted") {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the fork: ${JSON.stringify(owner.snapshot(forkId)?.control?.transfers)}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const forked = owner.snapshot(forkId)!
  const forkState = forked.control!.transfers.at(-1)!.state
  assert.equal(forkState.kind === "accepted" && forkState.carried, "native", "a fork with no native fork opens on its history in the harness's own store")
  assert.deepEqual(starts, [`imported-${emitted.length}`])
  assert.match(JSON.stringify(emitted.at(-1)?.entries), /Plan the parser.*Keep the recursive descent parser/)
  assert.deepEqual(forked.requests.find((item) => item.id === forkRequest)?.context, [], "and sends no transcript")

  starts.length = 0
  const fileEmitter = emitter
  writeFileSync(join(root, "account", "sessions.db"), "")
  emitter = async (thread) => {
    emitted.push(thread)
    return { sessionId: `row-${emitted.length}`, path: join(root, "account", "sessions.db") + `#row-${emitted.length}` }
  }
  const row = await move("native")
  assert.equal(row.state.carried, "native", JSON.stringify(row.state))
  assert.equal(row.binding?.path, `${realpathSync(join(root, "store", "sessions.db"))}#row-${emitted.length}`,
    "a session written as a row of a shared store binds the store's real path and the row")
  emitter = fileEmitter

  starts.length = 0
  emitter = async () => { throw new Error("disk full") }
  const unwritten = await move("native")
  assert.deepEqual(starts, [undefined])
  assert.match(unwritten.state.fallback ?? "", /Writing its session failed: disk full/)
  assert.equal(unwritten.request?.context?.length, 1)

  starts.length = 0
  emitter = undefined
  const unsupported = await move("native")
  assert.deepEqual(starts, [undefined])
  assert.match(unsupported.state.fallback ?? "", /no session import/)
  assert.equal(unsupported.request?.context?.length, 1)
  console.log("Native carry: a move or a fork resumes the session written for it and sends no transcript; a refused, swapped, unwritten or unsupported import goes as transcript and says why")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
  process.exit()
}

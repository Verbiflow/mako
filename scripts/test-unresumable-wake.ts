import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { ResumeVerdict } from "@mako/host/contracts/conversation-control"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"
import { registeredHarnessIds } from "./registered-harnesses.ts"

async function until(test: () => boolean, reason: string) {
  const deadline = Date.now() + 3_000
  while (!test()) {
    assert.ok(Date.now() < deadline, reason)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function check(provider: string, verdict: ResumeVerdict, scenario?: "stop" | "prewarm" | "failed-start" | "close" | "restart") {
  const root = mkdtempSync(join(tmpdir(), "mako-unresumable-wake-"))
  const id = randomUUID()
  const first = randomUUID()
  const second = randomUUID()
  const starts: Array<string | undefined> = []
  const prompts: string[] = []
  const sessions = new Map<string, LiveSessionState>()
  const emits = new Map<string, NonNullable<Parameters<ProviderLiveDriver["start"]>[1]["emit"]>>()
  let inspected = false
  let inspections = 0
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
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
    provider,
    available: () => true,
    async start(cwd, options) {
      starts.push(options.resume)
      if (scenario === "failed-start") throw new Error("Permission denied: the fixture account cannot open a session")
      assert.equal(options.pinnedAccount?.(), "fixture-account", "a fresh session stays on the original account")
      assert.equal(options.tuning?.model, "fixture-model")
      assert.equal(options.modeId, "full")
      const session: LiveSessionState = { id: options.conversationId, nativeId: options.resume ?? `fresh-${options.conversationId}`, nativePath: options.threadPath ?? join(root, options.conversationId), harness: provider, cwd, status: "ready", connection: "connected", modes: [{ id: "full", name: "Full" }], currentMode: "full", configOptions: [] }
      sessions.set(session.id, session)
      if (options.emit) emits.set(session.id, options.emit)
      return session
    },
    async prompt(binding, text, _attachments, _settings, dispatch) {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      prompts.push(text)
      const session = sessions.get(binding)!
      emits.get(binding)?.({ type: "live-session", session: { ...session, status: "running" } })
      emits.get(binding)?.({ type: "live-session", session })
    },
    async cancel() {}, async permission() {}, async setMode() {}, async close() {},
  }
  const dependencies: ConstructorParameters<typeof LiveConversations>[0] = {
    root: join(root, "journals"), appPath: root, driver: () => driver, emit: () => {},
    history: async (path) => ({ ref: { harness: provider, nativeId: "old-native", path, cwd: root, title: "Saved conversation", settings: { model: "fixture-model" } }, entries: [{ type: "user", id: "old-user", text: "Remember KESTREL" }, { type: "text", id: "old-answer", text: "Keep the parser recursive" }], start: 0, total: 2, hasEarlier: false }),
    resumeVerdict: async (binding) => { inspected = true; inspections += 1; await wait; return binding.nativeId === "old-native" ? verdict : { kind: "resumable", record: "same" } },
  }
  let owner = new LiveConversations(dependencies)
  try {
    await owner.capture(id, join(root, "old-record"))
    owner.adoptPin(id, provider, "fixture-account")
    await owner.setMode(id, "full")
    if (scenario === "prewarm") {
      assert.equal(owner.prewarm(id), "waking")
      await until(() => inspected, "prewarm never inspected the closed session")
      release()
      await until(() => owner.snapshot(id)?.session.status === "ready", "the message-free prewarm did not settle")
      assert.deepEqual(starts, [], "typing alone opens no transcript replacement")
      assert.equal(owner.snapshot(id)?.control?.transfers.length, 0)
    }
    owner.submit(id, first, "Write the parser")
    await until(() => inspected, "the queued reply did not inspect its saved session")
    owner.submit(id, second, "Then explain its grammar")
    if (scenario === "stop") await owner.cancel(id)
    const closing = scenario === "close" ? owner.close(id) : undefined
    release()
    await closing
    const safe = verdict.kind === "closed" || (verdict.kind === "unavailable" && verdict.lost === true)
    if (scenario === "failed-start") {
      await until(() => owner.snapshot(id)?.control?.transfers.some((move) => move.state.kind === "failed") === true, "a failed replacement did not settle")
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.deepEqual(starts, [undefined], "a terminal startup refusal never loops opening replacements")
      assert.deepEqual(prompts, [])
      assert.ok(owner.snapshot(id)?.requests.every((row) => row.status === "queued"), "failed startup preserves both original messages")
    } else if (safe && scenario !== "stop" && scenario !== "close") {
      await until(() => owner.snapshot(id)?.requests.find((row) => row.id === second)?.status === "completed", `${provider}: a closed/lost native session stranded its queued replies`)
      assert.deepEqual(starts, [undefined], "a single fresh session starts; the closed native record never opens")
      const snapshot = owner.snapshot(id)!
      assert.deepEqual(snapshot.requests.map((row) => row.id), [first, second], "queued request identities and order survive")
      assert.ok(snapshot.requests.every((row) => row.status === "completed"))
      assert.equal(prompts.length, 2)
      const transfer = snapshot.control?.transfers.find((move) => move.state.kind === "accepted")
      assert.ok(transfer?.state.kind === "accepted")
      assert.equal(transfer.state.manifest.includesBase, true)
      const transcript = readFileSync(transfer.state.manifest.file, "utf8")
      assert.match(transcript, /Remember KESTREL/)
      assert.match(transcript, /Keep the parser recursive/)
      assert.ok(prompts[0].includes(transfer.state.manifest.file), "the first queued request carries the saved transcript")
      assert.match(prompts[0], /Write the parser/)
      assert.match(prompts[1], /Then explain its grammar/)
      assert.doesNotMatch(prompts[1], /Remember KESTREL/)
      assert.equal(snapshot.control?.bindings.length, 2, "the original native binding remains in history")
      // It went on as a resend would: the session's own reconnect, which weighs the record again (closed, lost, or a
      // session that never ran a turn), never a quiet move around that rule.
      assert.equal(transfer.reconnects, true, "the wake hands its queue to the session's own reconnect")
      assert.ok(inspections >= 2, `the reconnect weighed the record again (${inspections} inspections)`)
      assert.equal(snapshot.control?.transfers.filter((move) => move.state.kind === "accepted").length, 1)
      if (scenario === "restart") {
        const nativeId = snapshot.session.nativeId
        await owner.stop()
        owner = new LiveConversations(dependencies)
        assert.equal(owner.snapshot(id)?.session.nativeId, nativeId, "the replacement binding survives a real journal reload")
        assert.deepEqual(starts, [undefined], "restart alone starts no executor or replay")
        const third = randomUUID()
        owner.submit(id, third, "Check the implementation")
        await until(() => owner.snapshot(id)?.requests.find((row) => row.id === third)?.status === "completed", "the replacement session failed to resume after restart")
        assert.deepEqual(starts, [undefined, nativeId], "the next reply resumes the replacement, never the closed source")
        assert.equal(prompts.length, 3, "neither completed message replays after restart")
      }
    } else {
      await until(() => owner.snapshot(id)?.session.status !== "starting", "the refused wake did not settle")
      assert.deepEqual(starts, [], "Stop or unverified ownership never creates a replacement executor")
      assert.deepEqual(prompts, [])
    }
  } finally {
    release()
    await owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

for (const harness of registeredHarnessIds()) {
  await check(harness, { kind: "closed", reason: "This native record cannot reopen." })
  await check(harness, { kind: "unavailable", lost: true, reason: "This native record no longer exists." })
}
await check("codex", { kind: "unavailable", reason: "Whether another process has this session open could not be checked." })
await check("codex", { kind: "held", by: "another process" })
for (const scenario of ["stop", "prewarm", "failed-start", "close", "restart"] as const)
  await check("codex", { kind: "closed", reason: "This native record cannot reopen." }, scenario)
console.log("PASS: closed/lost wakes carry the full transcript and original queue once; unknown ownership, known holders and Stop start nothing")

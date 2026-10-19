import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { z } from "zod"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  nativeCheckpoint,
  canResumeBinding,
  resumeVerdict,
} from "@mako/host/harnesses/native-continuation"
import type { ProviderBinding } from "@mako/host/contracts/conversation-control"
import type { ProviderProcessProbe } from "@mako/host/threads/harnesses"
import { assessProviderResume, verifyRecoveredSession } from "@mako/host/harnesses/provider-recovery"
import { launchContext } from "@mako/host/base/execution-context"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { resumable } from "@mako/host/contracts/conversation-control"
import type { NativeResumeEvidence } from "@mako/host/harnesses/native-continuation"
import { claudeSessionCheckpoint } from "@mako/host/harnesses/claude/session-checkpoint"
import { grokSessionCheckpoint } from "@mako/host/harnesses/grok/session-checkpoint"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))

const root = await mkdtemp(join(tmpdir(), "mako-checkpoint-"))
try {
  const path = join(root, "native.jsonl")
  await writeFile(path, "original history\n")
  const checkpoint = await nativeCheckpoint(path)
  assert.ok(checkpoint)
  const binding: ProviderBinding = {
    id: "fixture",
    provider: "fixture",
    nativeId: "native-fixture",
    path,
    checkpoint,
    coveredBlocks: 3,
    includesBase: true,
  }
  const idle: ProviderProcessProbe = {
    provider: "fixture",
    probe: async () => ({ kind: "available", sessions: [] }),
  }
  assert.equal(await canResumeBinding(binding, idle), true)
  const legacy = { ...binding, checkpoint: undefined }
  const legacyVerdict = await resumeVerdict(legacy, idle)
  assert.deepEqual(legacyVerdict, { kind: "resumable", record: "unknown" }, "an existing native file without an old checkpoint can reconnect")
  assert.equal(await canResumeBinding(legacy, idle), false, "unknown comparison does not permit unchanged-history reuse")
  assert.equal((await resumeVerdict(legacy, undefined)).kind, "unavailable", "legacy bindings still require ownership evidence")

  assert.equal(await canResumeBinding(binding, undefined), false)
  assert.equal(
    await canResumeBinding(binding, {
      ...idle,
      probe: async () => ({ kind: "unavailable", reason: "failed" }),
    }),
    false
  )
  assert.equal(
    await canResumeBinding(binding, {
      ...idle,
      probe: async () => {
        throw new Error("probe failed")
      },
    }),
    false
  )
  for (const session of [{ nativeId: binding.nativeId }, { path }]) {
    const busy: ProviderProcessProbe = {
      ...idle,
      probe: async () => ({
        kind: "available",
        sessions: [{ ...session, status: "active" }],
      }),
    }
    assert.equal((await resumeVerdict(legacy, busy)).kind, "held", "missing checkpoint cannot bypass active ownership")
    assert.equal(await canResumeBinding(binding, busy), false)
    assert.deepEqual(await resumeVerdict(binding, busy), { kind: "held", by: "another fixture process" })
  }
  await writeFile(path, "modified history\n")
  assert.equal(await canResumeBinding(binding, idle), false, "a switch does not reuse a binding whose record moved")
  assert.deepEqual(
    await resumeVerdict(binding, idle),
    { kind: "resumable", record: "moved" },
    "a record that moved is still the same unowned session for a reconnect"
  )
  assert.equal((await resumeVerdict(binding, undefined)).kind, "unavailable", "no probe means ownership cannot be answered")
  assert.match(checkpoint, /^v2:/, "a checkpoint reads identity and the tail, not the whole record")
  const saved = createHash("sha256").update(await readFile(path)).digest("hex")
  assert.deepEqual(
    await resumeVerdict({ ...binding, checkpoint: saved }, idle),
    { kind: "resumable", record: "same" },
    "a binding saved with a whole-record digest still compares unchanged"
  )
  const large = join(root, "large.jsonl")
  await writeFile(large, `${"x".repeat(200_000)}\nend-a\n`)
  const largeBefore = await nativeCheckpoint(large)
  await writeFile(large, `${"x".repeat(200_000)}\nend-b\n`)
  assert.notEqual(await nativeCheckpoint(large), largeBefore, "a same-size rewrite of the tail moves the checkpoint")
  await rm(path)
  assert.equal((await resumeVerdict(binding, idle)).kind, "unavailable")
  assert.equal(await nativeCheckpoint(root), undefined)
  // A harness goes on in another folder only on a test against the real harness that a suite runs.
  const suites = Object.values(z.object({ scripts: z.record(z.string(), z.string()) }).parse(JSON.parse(await readFile("package.json", "utf8"))).scripts).join(" ")
  for (const driver of providerHost.liveDrivers.list()) {
    const elsewhere = driver.resume.kind === "native" ? driver.resume.elsewhere : undefined
    if (!elsewhere) continue
    const test = /scripts\/[\w.-]+\.(?:ts|mjs)/.exec(elsewhere.verified)?.[0]
    assert.ok(test && existsSync(test), `${driver.provider}: resume.elsewhere names the test that proved it`)
    assert.ok(suites.includes(test), `${driver.provider}: a package script runs ${test}`)
  }
  // Every installed declaration, plus a new harness, shares the decision owner.
  // Inject native facts here; real file/DB/SDK readers have separate fixture oracles.
  for (const driver of [...providerHost.liveDrivers.list(), { ...providerHost.liveDrivers.list()[0], provider: "future-harness" }]) {
    const resume = driver.resume
    assert.ok(resume.kind === "native", `${driver.provider}: explicit native recovery contributions`)
    const inspecting = (base: ProviderLiveDriver, inspect: () => Promise<NativeResumeEvidence>): ProviderLiveDriver => ({ ...base, resume: { ...resume, inspect } })
    const saved = { ...binding, provider: driver.provider }
    let reads = 0
    let evidence: NativeResumeEvidence = { kind: "available", checkpoint: checkpoint!, strategy: "same-session" }
    const adapter = inspecting({ ...driver, nativeSource: undefined }, async () => { reads++; return evidence })
    assert.deepEqual(await assessProviderResume(saved, adapter), { kind: "resumable", record: "same" })
    assert.deepEqual(await assessProviderResume({ ...saved, checkpoint: undefined }, adapter), { kind: "resumable", record: "unknown" })
    evidence = { kind: "available", checkpoint: "new revision", strategy: "copy" }
    assert.equal(resumable(await assessProviderResume(saved, adapter), "same"), false)
    evidence = { kind: "held", by: "independent native owner" }
    assert.deepEqual(await assessProviderResume(saved, adapter), evidence, "changing ownership cannot reuse a cached permission")
    assert.equal(reads, 4)
    const missing = await assessProviderResume(saved, { ...adapter, resume: { kind: "not-built", reason: "Fixture" } })
    assert.equal(missing.kind, "unavailable")
    assert.equal((await assessProviderResume(saved, { ...adapter, provider: "wrong-owner" })).kind, "unavailable")
    assert.equal(reads, 4, "invalid ownership/implementation is refused before native I/O")
    assert.equal((await assessProviderResume(saved, inspecting(adapter, async () => { throw new Error("read failed") }))).kind, "unavailable")
    const oldContext = launchContext("native-fixture", driver.nativeIdentity, { name: "managed-a", dir: "/account-a" })
    oldContext.store = { kind: "located", path: saved.path! }
    const observedContext = { ...oldContext, account: { kind: "configured" as const, name: "managed-b", managed: true } }
    const retained = { ...saved, executionContext: oldContext }
    const session: LiveSessionState = { id: saved.id, harness: driver.provider, nativeId: saved.nativeId, nativePath: saved.path,
      executionContext: observedContext, cwd: root, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
    const same = inspecting(adapter, async () => ({ kind: "available", checkpoint: checkpoint!, strategy: "same-session" }))
    await verifyRecoveredSession(retained, session, same)
    await assert.rejects(verifyRecoveredSession(retained, { ...session, nativeId: "wrong-id" }, same), /different native session/)
    await assert.rejects(verifyRecoveredSession(retained, { ...session, nativePath: "/other/store", executionContext: { ...observedContext, store: {kind:"located",path:"/other/store"} } }, same), /different native store/)
    await assert.rejects(verifyRecoveredSession(retained, { ...session, nativePath: "/other/store" }, same), /disagrees/)
    await assert.rejects(verifyRecoveredSession(retained, { ...session, nativePath: undefined, executionContext: {...observedContext,store:{kind:"unavailable",reason:"not located"}} }, same), /did not locate/)
    await assert.rejects(verifyRecoveredSession(saved, { ...session, nativePath: undefined, executionContext: undefined }, same), /did not locate/, "legacy context cannot bypass locating the actual reopened source")
    const inconsistent = { ...retained, executionContext: {...oldContext,store:{kind:"located" as const,path:"/other/store"}} }
    assert.equal((await assessProviderResume(inconsistent, same)).kind, "unavailable", "a stale context cannot be silently replaced before native admission")
    const copy = inspecting(same, async () => ({ kind: "available", checkpoint: checkpoint!, strategy: "copy" }))
    await assert.rejects(verifyRecoveredSession(retained, { ...session, nativePath: "/copied/store", executionContext: undefined }, copy), /exact import receipt/, "copy support cannot authorize an arbitrary destination")
    const imported = { ...session, nativePath: "/copied/store", executionContext: { ...observedContext, store: { kind: "located" as const, path: "/copied/store" }, sourceImport: { source: saved.path!, destination: "/copied/store", nativeId: saved.nativeId!, via: "native import response", revision: checkpoint! } } }
    await verifyRecoveredSession(retained, imported, copy)
    await assert.rejects(verifyRecoveredSession(retained, { ...imported, executionContext: { ...imported.executionContext, sourceImport: { ...imported.executionContext.sourceImport, revision: undefined } } }, copy), /revision/, "old path-only receipts do not prove copied history")
    await assert.rejects(verifyRecoveredSession(retained, { ...imported, executionContext: { ...imported.executionContext, sourceImport: { ...imported.executionContext.sourceImport, revision: "old-source-head" } } }, copy), /revision/, "source movement after copying cannot authorize input")
    await assert.rejects(verifyRecoveredSession(retained, { ...imported, executionContext: { ...imported.executionContext, sourceImport: { ...imported.executionContext.sourceImport, destination: "/unrelated/store" } } }, copy), /exact import receipt/)
    await assert.rejects(verifyRecoveredSession(retained, { ...imported, executionContext: { ...imported.executionContext, sourceImport: { ...imported.executionContext.sourceImport, nativeId: "other-native-id" } } }, copy), /exact import receipt/)
    await assert.rejects(verifyRecoveredSession(retained, imported, same), /verify the imported/)
    await assert.rejects(verifyRecoveredSession(retained, { ...session, executionContext: { ...observedContext, transport: "other-transport" } }, same), /transport changed/)
    // Old journals predate execution context; native identity/source readers remain their admission evidence.
    await verifyRecoveredSession(saved, { ...session, executionContext: undefined }, same)
  }
  // Grok goes on in another folder once its session's folder is filed under
  // that folder's name in the same sessions folder: the same source, moved.
  const grok = providerHost.liveDrivers.list().find((driver) => driver.provider === "grok")
  assert.ok(grok?.resume.kind === "native" && grok.resume.elsewhere)
  const nativeId = "01a12490-5e0f-7dd2-970f-5ab2c99308a4"
  const filed = (home: string, cwd: string) => join(root, home, "sessions", encodeURIComponent(cwd), nativeId, "updates.jsonl")
  const before = filed("grok", "/project")
  const moved = filed("grok", "/project-worktree")
  await mkdir(dirname(moved), { recursive: true })
  await writeFile(moved, "{}\n")
  const grokBinding: ProviderBinding = { id: "grok-move", provider: "grok", nativeId, path: before, coveredBlocks: 1, includesBase: true }
  const reopened = (path: string): LiveSessionState => ({ id: "grok-move", harness: "grok", nativeId, nativePath: path, cwd: "/project-worktree",
    status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] })
  await verifyRecoveredSession(grokBinding, reopened(moved), grok)
  await assert.rejects(verifyRecoveredSession(grokBinding, reopened(filed("another-grok-home", "/project-worktree")), grok), /different native store/,
    "a session filed in another Grok home is another store")
  // Claude Code writes bookkeeping after a turn and as its process exits; a
  // switch back must still find its session where the conversation left it.
  const transcript = join(root, "claude.jsonl")
  const line = <Line,>(record: Line) => `${JSON.stringify(record)}\n`
  const conversation = [
    line({ type: "custom-title", customTitle: "Fixture", sessionId: "s" }),
    line({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: "Remember the marker." }, uuid: "u1", timestamp: "2026-10-17T06:11:09.371Z" }),
    line({ parentUuid: "u1", isSidechain: false, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `ACK ${"y".repeat(100_000)}` }] }, uuid: "a1", timestamp: "2026-10-17T06:11:11.183Z" }),
    line({ parentUuid: "a1", isSidechain: false, type: "system", subtype: "stop_hook_summary", uuid: "s1", timestamp: "2026-10-17T06:11:11.252Z" }),
  ].join("")
  await writeFile(transcript, `${conversation}${line({ type: "last-prompt", lastPrompt: "Remember the marker.", leafUuid: "s1", sessionId: "s" })}`)
  const left = await claudeSessionCheckpoint(transcript)
  assert.match(left ?? "", /^c1:/)
  const claudeBinding: ProviderBinding = { ...binding, provider: "claude", path: transcript, checkpoint: left }
  const claudeVerdict = () => resumeVerdict(claudeBinding, idle, claudeReader)
  const claudeReader = async (saved: ProviderBinding) => {
    const current = await claudeSessionCheckpoint(saved.path!, saved.checkpoint)
    return current === undefined ? { kind: "unavailable" as const, reason: "gone" } : { kind: "available" as const, checkpoint: current }
  }
  // What Claude Code 2.1.296 appended to a session as Mako closed its process on a switch (session flows, 2026-10-17).
  await writeFile(transcript, [
    line({ type: "custom-title", customTitle: "Fixture", sessionId: "s" }),
    line({ type: "atis-latch", atis: true, sessionId: "s" }),
    line({ type: "cost-state", sessionId: "s", totalCostUSD: 0.01 }),
    line({ type: "queue-operation", operation: "dequeue", timestamp: "2026-10-17T06:11:12.000Z", sessionId: "s" }),
  ].join(""), { flag: "a" })
  assert.equal(await claudeSessionCheckpoint(transcript), left, "bookkeeping after the conversation leaves its checkpoint where it was")
  assert.deepEqual(await claudeVerdict(), { kind: "resumable", record: "same" }, "a switch back reuses the session Claude Code closed")
  const claudeEvidence = providerHost.liveDrivers.get("claude")?.resume
  assert.ok(claudeEvidence?.kind === "native" && claudeEvidence.checkpoint === claudeSessionCheckpoint, "Claude's driver checkpoints its sessions this way")
  assert.equal(await claudeSessionCheckpoint(transcript, checkpoint), await nativeCheckpoint(transcript, checkpoint), "a binding saved with the whole-file checkpoint is compared in that form")
  await writeFile(transcript, line({ type: "last-prompt", lastPrompt: "Remember the marker.", leafUuid: "u1", explicit: true, sessionId: "s" }), { flag: "a" })
  assert.deepEqual(await claudeVerdict(), { kind: "resumable", record: "moved" }, "a rewind outside Mako moves the conversation")
  await writeFile(transcript, `${conversation}${line({ parentUuid: "s1", isSidechain: false, type: "user", message: { role: "user", content: "Continued outside Mako." }, uuid: "u2" })}${line({ type: "cost-state", sessionId: "s" })}`)
  assert.deepEqual(await claudeVerdict(), { kind: "resumable", record: "moved" }, "a turn outside Mako moves the conversation")
  await writeFile(transcript, `${line({ type: "custom-title", customTitle: "Only bookkeeping", sessionId: "s" })}${line({ type: "cost-state", sessionId: "s" })}`)
  assert.match(await claudeSessionCheckpoint(transcript) ?? "", /^c1:\d+:0:/, "a file of bookkeeping alone holds no conversation")
  await rm(transcript)
  assert.equal(await claudeSessionCheckpoint(transcript), undefined)

  // Grok 1.0.46 writes its Stop and SessionEnd hooks' runs after the turn ends, the last as Mako closes its process.
  const updates = join(root, "updates.jsonl")
  const update = (sessionUpdate: string, extra = {}) => line({ timestamp: 1792219337, method: "_x.ai/session/update", params: { sessionId: "g", update: { sessionUpdate, ...extra } } })
  const turn = [
    update("hook_execution", { event_name: "user_prompt_submit", runs: [] }),
    update("user_message_chunk", { content: { type: "text", text: "Remember the marker." } }),
    update("agent_message_chunk", { content: { type: "text", text: "ACK" } }),
    update("turn_completed", { stop_reason: "end_turn" }),
  ].join("")
  await writeFile(updates, turn)
  const grokLeft = await grokSessionCheckpoint(updates)
  assert.match(grokLeft ?? "", /^g1:/)
  await writeFile(updates, [
    update("hook_execution", { event_name: "session_end", runs: [{ name: "global/notify:session_end[0].hooks[0]", status: { status: "failed", error: "session closed before the hook ran" } }] }),
    update("hook_execution", { event_name: "stop", runs: [] }),
  ].join(""), { flag: "a" })
  assert.equal(await grokSessionCheckpoint(updates), grokLeft, "Grok's hook runs after the turn leave its checkpoint where it was")
  const grokEvidence = providerHost.liveDrivers.get("grok")?.resume
  assert.ok(grokEvidence?.kind === "native" && grokEvidence.checkpoint === grokSessionCheckpoint, "Grok's driver checkpoints its sessions this way")
  await writeFile(updates, update("user_message_chunk", { content: { type: "text", text: "Continued outside Mako." } }), { flag: "a" })
  assert.notEqual(await grokSessionCheckpoint(updates), grokLeft, "a turn outside Mako moves the conversation")
  assert.equal(await grokSessionCheckpoint(updates, checkpoint), await nativeCheckpoint(updates, checkpoint), "a binding saved with the whole-file checkpoint is compared in that form")
  console.log(
    "Native continuation: unchanged file accepted; moved record reconnects but is not reused; missing, active, unavailable and failed probes denied; a Grok session refiled under another folder is the same source; Claude Code's and Grok's bookkeeping after a turn doesn't move their sessions"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

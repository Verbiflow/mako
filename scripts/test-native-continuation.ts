import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { z } from "zod"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  nativeCheckpoint,
  canResumeBinding,
  resumeVerdict,
} from "../electron/native-continuation.ts"
import type { ProviderBinding } from "../electron/contracts/conversation-control.ts"
import type { ProviderProcessProbe } from "../electron/providers/process-probe.ts"
import { assessProviderResume, verifyRecoveredSession } from "../electron/provider-recovery.ts"
import { launchContext } from "../electron/execution-context.ts"
import type { LiveSessionState } from "../electron/shared.ts"
import { providerHost } from "../electron/providers/index.ts"
import { resumable } from "../electron/contracts/conversation-control.ts"
import type { NativeResumeEvidence } from "../electron/native-continuation.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"

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
  console.log(
    "Native continuation: unchanged file accepted; moved record reconnects but is not reused; missing, active, unavailable and failed probes denied"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

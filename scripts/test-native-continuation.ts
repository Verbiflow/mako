import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  nativeCheckpoint,
  canResumeBinding,
  resumeVerdict,
} from "../electron/native-continuation.ts"
import type { ProviderBinding } from "../electron/contracts/conversation-control.ts"
import type { ProviderProcessProbe } from "../electron/providers/process-probe.ts"

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
  await rm(path)
  assert.equal((await resumeVerdict(binding, idle)).kind, "unavailable")
  assert.equal(await nativeCheckpoint(root), undefined)
  console.log(
    "Native continuation: unchanged file accepted; moved record reconnects but is not reused; missing, active, unavailable and failed probes denied"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

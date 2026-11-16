import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONTEXT_COMPACTED } from "@mako/host/contracts/native-activity"
import { compactionWorld } from "./lib/compaction-world.ts"

for (const name of ["productive", "historical", "host-prose", "permission"] as const) {
  const root = mkdtempSync(join(tmpdir(), "mako-compact-native-")), world = compactionWorld(root, { automatic: true })
  try {
    await world.start()
    const binding = world.owner.snapshot(world.id)!.control!.activeBindingId
    const emit = world.events.get(binding)!
    if (name === "historical") {
      emit({ type: "live-update", id: binding, update: { kind: "event", label: CONTEXT_COMPACTED } })
      emit({ type: "live-session", session: { ...world.state(binding, "failed"), failureEvidence: { kind: "context-exhausted", source: "native-error" } } })
    } else {
      world.control.holdPrompt = name === "productive"
      world.control.failPrompt = name !== "productive"
      world.control.failure = name === "host-prose" ? { kind: "unknown", source: "host" } : { kind: "permission", source: "native-error" }
      world.owner.submit(world.id, randomUUID(), "ordinary work")
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
      if (name === "productive") {
        emit({ type: "live-activity", id: binding, activity: { kind: "compacting" } })
        emit({ type: "live-update", id: binding, update: { kind: "event", label: "Compaction failed", detail: "Historical summary did not finish" } })
        emit({ type: "live-update", id: binding, update: { kind: "text", text: "The agent continues productively after its summary attempt." } })
        assert.equal(world.owner.snapshot(world.id)!.session.status, "running", "a summary observation cannot interrupt productive native work")
        emit({ type: "live-session", session: { ...world.state(binding), lastStop: "completed" } })
      }
    }
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(world.owner.snapshot(world.id)!.control!.compactionRecovery, undefined)
    assert.equal(world.calls.length, 0)
    assert.equal(world.launches.length, 1)
    console.log(`PASS: automatic-only admission refuses ${name}`)
  } finally { await world.close(); rmSync(root, { recursive: true, force: true }) }
}

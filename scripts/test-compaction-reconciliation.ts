import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { COMPACTION_CONFIRMATION_MS } from "@mako/host/contracts/recovery"
import { compactionWorld } from "./lib/compaction-world.ts"

async function until(why: string, check: () => boolean) {
  const end = performance.now() + 3_000
  while (!check()) { assert.ok(performance.now() < end, why); await new Promise(resolve => setTimeout(resolve, 5)) }
}
for (const name of ["deadline", "late", "retry-deadline", "automatic", "automatic-loop", "stop", "unreadable", "holder", "late-close", "late-read", "late-replaced", "source-change", "stop-read", "archive-read", "late-start", "close-open-unknown"] as const) {
  if (process.argv.some(arg => arg.startsWith("--case=")) && !process.argv.includes(`--case=${name}`)) continue
  const root = mkdtempSync(join(tmpdir(), "mako-compact-reconcile-"))
  const barrier = Promise.withResolvers<void>()
  let entered = false, inspections = 0
  const world = compactionWorld(root, { closing: async () => { if (name === "late-close" && !entered) { entered = true; await barrier.promise } },
    inspect: async () => name === "holder" ? { kind: "held", by: "scripted independent executor" }
      : { kind: "available", checkpoint: name === "source-change" ? String(++inspections) : "scripted", strategy: "same-session" },
    automatic: name.startsWith("automatic"), history: async page => {
      if (["late-read", "stop-read", "archive-read", "late-start"].includes(name) && !entered) { entered = true; await barrier.promise }
      return name === "unreadable" ? null : page
    }, starting: async () => {
      if (name === "automatic-loop" && world.launches.length === 2) world.control.failPrompt = true
      if (name === "late-start" && world.launches.length === 2) { entered = true; await barrier.promise }
    } })
  const { owner, id, calls } = world
  try {
    await world.start()
    const originalBinding = owner.snapshot(id)!.control!.activeBindingId
    const queued = randomUUID()
    if (name.startsWith("automatic")) {
      world.control.failPrompt = true
      owner.submit(id, queued, "work accepted before a terminal context failure")
      await until("automatic-only terminal failure creates a successor", () => world.launches.length === 2)
      await until("the discovery turn settles", () => owner.snapshot(id)!.requests.some(request => request.continues?.requestId === queued && request.status === (name === "automatic-loop" ? "failed" : "completed")))
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(world.launches.length, 2, "a failed automatic recovery turn cannot manufacture a fresh-session loop")
      assert.equal(calls.length, 0, "an automatic-only harness never gets a manual compact")
      assert.equal(world.prompts.filter(prompt => prompt.text.includes("work accepted before a terminal context failure")).length, 1)
    } else {
      await owner.act(id, { kind: "compact", id: randomUUID() })
      owner.submit(id, queued, "queued once, in order")
      if (name === "retry-deadline") { world.fail(calls[0]!); await until("one retry", () => calls.length === 2) }
      const call = calls.at(-1)!
      world.result(call, { kind: "uncertain", reason: "Scripted reply lost" })
      await until("uncertainty owns a durable reconciliation episode", () => owner.snapshot(id)!.control!.compactionRecovery?.state.kind === "reconcile")
      const snapshot = owner.snapshot(id)!
      const recovery = snapshot.control!.compactionRecovery!
      assert.equal(world.launches.length, 1, "no replacement before the persisted deadline")
      if (name === "close-open-unknown") {
        await owner.close(id)
        assert.equal(owner.snapshot(id)!.requests.find(request => request.id === queued)?.status, "queued")
        owner.submit(id, randomUUID(), "new words explicitly reopen")
        assert.equal(owner.snapshot(id)!.control!.compactionRecovery?.state.kind, "reconcile", "reopening an unknown compact still requires source reconciliation")
      }
      if (name === "late") {
        world.result(call, { kind: "completed" })
        await until("late native success drains the queue", () => owner.snapshot(id)!.requests.find(request => request.id === queued)?.status === "completed")
        assert.equal(world.launches.length, 1)
      } else if (name === "stop") {
        await owner.cancel(id)
        world.result(call, { kind: "completed" })
        assert.equal(owner.snapshot(id)!.control!.compactionRecovery?.state.kind, "withdrawn")
        assert.equal(owner.snapshot(id)!.requests.find(request => request.id === queued)?.pause, "stop")
      } else {
        mock.timers.enable({ apis: ["Date"], now: recovery.state.kind === "reconcile" ? recovery.state.deadline + 1 : recovery.createdAt + COMPACTION_CONFIRMATION_MS + 1 })
        await owner.wakeDue(Date.now())
        await owner.wakeDue(Date.now())
        if (["late-close", "late-read", "stop-read", "archive-read", "late-start"].includes(name)) {
          await until("reconciliation waits at its source boundary", () => entered)
          if (name === "stop-read") owner.stopHolds(id)
          else if (name === "archive-read") owner.setArchived(id, true)
          else world.result(call, { kind: "completed" })
          barrier.resolve()
          if (name === "stop-read" || name === "archive-read") {
            await new Promise(resolve => setTimeout(resolve, 30))
            assert.equal(world.launches.length, 1)
            assert.equal(world.prompts.length, 0)
          } else {
            await until("exact native success fences an awaited handoff", () => owner.snapshot(id)!.requests.find(request => request.id === queued)?.status === "completed")
            assert.equal(owner.snapshot(id)!.control!.activeBindingId, originalBinding)
            assert.ok(world.launches.slice(name === "late-start" ? 2 : 1).every(launch => launch.resume), "only the proven successful source may be reopened")
            assert.equal(world.prompts.length, 1)
          }
        } else if (["unreadable", "holder", "source-change"].includes(name)) {
          await new Promise(resolve => setTimeout(resolve, 50))
          assert.equal(world.launches.length, 1, "unverified source or ownership cannot authorize a fresh binding")
          const state = owner.snapshot(id)!.control!.compactionRecovery!.state
          assert.ok(state.kind === "reconcile" && state.at > Date.now(), "failed verification reuses the scheduled wake, without a hot loop")
          assert.equal(world.prompts.length, 0)
        } else {
          await until("the deadline gives verified history a fresh binding", () => owner.snapshot(id)!.requests.find(request => request.id === queued)?.status === "completed")
          assert.notEqual(owner.snapshot(id)!.control!.activeBindingId, originalBinding)
          assert.equal(world.launches[1]!.resume, undefined)
          assert.equal(world.launches[1]!.fork, undefined)
          assert.equal(world.prompts.length, name === "close-open-unknown" ? 2 : 1)
          if (name === "close-open-unknown") assert.equal(world.prompts[1]!.text, "new words explicitly reopen")
          if (name === "late-replaced") {
            const replaced = owner.snapshot(id)!.control!.activeBindingId
            world.result(call, { kind: "completed" })
            assert.equal(owner.snapshot(id)!.control!.activeBindingId, replaced)
            assert.equal(world.prompts.length, 1)
          }
          assert.equal(owner.snapshot(id)!.control!.actions?.find(action => action.input.id === call.action)?.state.kind, "uncertain", "replacement never forges compaction success")
        }
      }
      assert.equal(calls.length, name === "retry-deadline" ? 2 : 1, "unknown outcomes never compact again")
    }
    console.log(`PASS: compaction reconciliation ${name}`)
  } catch (error) { console.error(JSON.stringify({ name, control: owner.snapshot(id)?.control, session: owner.snapshot(id)?.session, requests: owner.snapshot(id)?.requests, logs: world.logs, launches: world.launches.length })); throw error } finally { barrier.resolve(); mock.timers.reset(); await world.close(); rmSync(root, { recursive: true, force: true }) }
}

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProviderFailureError } from "@mako/host/contracts/provider-failure"
import { JournalWriteError, LiveJournal } from "@mako/host/conversations/live-journal"
import { compactionWorld } from "./lib/compaction-world.ts"
async function until(why: string, check: () => boolean) {
  const end = performance.now() + 5_000
  while (!check()) { assert.ok(performance.now() < end, why); await new Promise(resolve => setTimeout(resolve, 5)) }
}
for (const mode of ["stop", "archive"] as const) {
  const root = mkdtempSync(join(tmpdir(), `mako-compact-fence-${mode}-`))
  let unblock!: () => void, entered = false
  const pending = new Promise<void>(resolve => { unblock = resolve })
  const world = compactionWorld(root, { closing: async () => { entered = true; await pending } })
  try {
    await world.start()
    await world.owner.act(world.id, { kind: "compact", id: randomUUID() })
    const queued = randomUUID()
    world.owner.submit(world.id, queued, "preserved behind source cleanup")
    world.fail(world.calls[0]!)
    await until("retry", () => world.calls.length === 2)
    world.fail(world.calls[1]!)
    await until("owned source cleanup", () => entered)
    if (mode === "stop") world.owner.stopHolds(world.id)
    else world.owner.setArchived(world.id, true)
    unblock()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(world.launches.length, 1, "a post-await withdrawal cannot start a fresh native session")
    assert.equal(world.prompts.length, 0)
    const recovery = world.owner.snapshot(world.id)!.control!.compactionRecovery!
    assert.deepEqual(recovery.state, { kind: "withdrawn", reason: mode })
    console.log(`PASS: ${mode} during source cleanup fences the delayed handoff`)
  } finally { unblock(); await world.close(); rmSync(root, { recursive: true, force: true }) }
}
{
  const root = mkdtempSync(join(tmpdir(), "mako-compact-retry-handoff-"))
  let refuse = true, starts = 0
  const world = compactionWorld(root, { starting: async () => {
    starts++
    if (starts > 1 && refuse) throw new ProviderFailureError("Synthetic account permission needed", { kind: "permission", source: "native-error" })
  } })
  try {
    await world.start()
    await world.owner.act(world.id, { kind: "compact", id: randomUUID() })
    const queued = randomUUID()
    world.owner.submit(world.id, queued, "never resend compact to repair an account")
    world.fail(world.calls[0]!)
    await until("retry", () => world.calls.length === 2)
    world.fail(world.calls[1]!)
    await until("specific destination failure", () => world.owner.snapshot(world.id)!.control!.transfers.some(transfer => transfer.state.kind === "failed"))
    const failed = world.owner.snapshot(world.id)!.control!.transfers.at(-1)!
    assert.equal(failed.state.kind === "failed" && failed.state.failure, "permission")
    refuse = false // the fixing action made the same destination usable; no credential or provider call is made
    assert.throws(() => world.owner.transfer(world.id, { ...failed.input, id: randomUUID(), recoveryOf: failed.input.id, tuning: { model: "different-target" } }), /destination changed/)
    const input = { ...failed.input, id: randomUUID(), recoveryOf: failed.input.id }
    world.owner.transfer(world.id, input)
    await until("exact explicit retry drains kept work", () => world.owner.snapshot(world.id)!.requests.find(request => request.id === queued)?.status === "completed")
    const count = starts
    world.owner.transfer(world.id, input)
    assert.equal(starts, count, "a duplicate retry only reads its original receipt")
    assert.throws(() => world.owner.transfer(world.id, { ...input, id: randomUUID() }), /destination changed/, "a stale failed handoff cannot reopen a newer completed episode")
    assert.equal(world.calls.length, 2)
    assert.equal(world.prompts.length, 1)
    assert.equal(world.launches.at(-1)!.resume, undefined)
    console.log("PASS: failed replacement keeps the concrete cause; exact retry, target CAS, duplicate and stale controls preserve the queue")
  } finally { await world.close(); rmSync(root, { recursive: true, force: true }) }
}
{
  const root = mkdtempSync(join(tmpdir(), "mako-compact-storage-")), world = compactionWorld(root, { saveAgainMs: 10 })
  const commit = LiveJournal.prototype.commit
  let blocked = true
  try {
    await world.start()
    await world.owner.act(world.id, { kind: "compact", id: randomUUID() })
    const queued = randomUUID()
    world.owner.submit(world.id, queued, "saved before any recovery effect")
    LiveJournal.prototype.commit = function(...args: Parameters<LiveJournal["commit"]>) {
      if (blocked && args[0].session.id === world.id && args[0].control?.compactionRecovery) throw new JournalWriteError(new Error("Synthetic storage refusal"))
      return commit.apply(this, args)
    }
    world.fail(world.calls[0]!)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(world.calls.length, 1, "no native retry before the episode is durable")
    assert.equal(world.launches.length, 1)
    blocked = false
    await until("the existing storage retry commits and resumes the episode", () => world.calls.length === 2)
    world.result(world.calls[1]!, { kind: "completed" })
    await until("saved work follows without Resume", () => world.owner.snapshot(world.id)!.requests.find(request => request.id === queued)?.status === "completed")
    assert.equal(world.prompts.length, 1)
    console.log("PASS: storage refusal prevents native effects and the existing save recovery resumes the same episode")
  } finally { LiveJournal.prototype.commit = commit; await world.close(); rmSync(root, { recursive: true, force: true }) }
}

{
  const root = mkdtempSync(join(tmpdir(), "mako-compact-old-ack-")), id = randomUUID()
  let world = compactionWorld(root, { id }), closed = 0
  try {
    await world.start()
    await world.owner.act(id, { kind: "compact", id: randomUUID() })
    world.fail(world.calls[0]!)
    await until("one retry", () => world.calls.length === 2)
    const retiredAction = world.calls[1]!.action
    await world.owner.close(id)
    const next = randomUUID()
    world.owner.submit(id, next, "carry on after Close")
    await until("replacement has delivered", () => world.owner.snapshot(id)!.requests.find(request => request.id === next)?.status === "completed")
    await world.close()
    // The old compact's deadline retained uncertainty in history; opening an older client may still acknowledge it.
    const journal = new LiveJournal(join(root, "journals"), id), saved = journal.read()!
    journal.commit({ ...saved, control: { ...saved.control!, actions: saved.control!.actions!.map(action => action.input.id === retiredAction
      ? { ...action, state: { kind: "uncertain", reason: "The retired source never confirmed its command" } } : action) } })
    journal.close()
    world = compactionWorld(root, { id, closing: async () => { closed++ } })
    const message = randomUUID()
    world.owner.submit(id, message, "the replacement is healthy")
    await until("the healthy replacement reopens", () => world.owner.snapshot(id)!.requests.find(request => request.id === message)?.status === "completed")
    const active = world.owner.snapshot(id)!.control!.activeBindingId
    await world.owner.acknowledgeAction(id, retiredAction)
    assert.equal(closed, 0, "acknowledging a retired binding's unknown action cannot disconnect the healthy active binding")
    assert.equal(world.owner.snapshot(id)!.control!.activeBindingId, active)
    assert.equal(world.owner.snapshot(id)!.session.connection, "connected")
    assert.equal(world.calls.length, 0)
    console.log("PASS: an old client's acknowledgement settles only the retired receipt, never the healthy replacement")
  } finally { await world.close(); rmSync(root, { recursive: true, force: true }) }
}

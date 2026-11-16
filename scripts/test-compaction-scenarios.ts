import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compactionWorld } from "./lib/compaction-world.ts"

async function until(why: string, check: () => boolean) {
  const end = performance.now() + 2_000
  while (!check()) { assert.ok(performance.now() < end, why); await new Promise(resolve => setTimeout(resolve, 5)) }
}
const cases = ["retry-success", "retry-uncertain-late", "failed-work", "unreceived-work", "stop", "close-open", "late-result", "stop-before-result", "auth", "permission", "service", "cancelled"] as const
for (const name of cases) {
  if (process.argv.some(arg => arg.startsWith("--case=")) && !process.argv.includes(`--case=${name}`)) continue
  const root = mkdtempSync(join(tmpdir(), `mako-compact-${name}-`)), world = compactionWorld(root)
  const { owner, id, calls } = world
  try {
    await world.start()
    const binding = owner.snapshot(id)!.control!.activeBindingId
    const original = randomUUID()
    if (name === "failed-work" || name === "unreceived-work") {
      if (name === "failed-work") world.control.failPrompt = true
      else world.control.rejectPrompt = true
      owner.submit(id, original, "original work with possible prior effects")
      await until("accepted work failed on its context", () => owner.snapshot(id)!.requests.find(request => request.id === original)?.status === "failed")
    }
    await owner.act(id, { kind: "compact", id: randomUUID(), ...((name === "failed-work" || name === "unreceived-work") && { requestId: original }) })
    const queued = randomUUID()
    if (name !== "failed-work" && name !== "unreceived-work") owner.submit(id, queued, "kept queued work")
    if (name === "stop-before-result") {
      await owner.cancel(id)
      world.fail(calls[0]!)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(calls.length, 1, "Stop before the first result forbids a new episode")
      assert.equal(world.launches.length, 1)
      assert.equal(owner.snapshot(id)!.control!.compactionRecovery, undefined)
      assert.equal(owner.snapshot(id)!.requests.find(request => request.id === queued)!.pause, "stop")
      console.log(`PASS: compaction ${name}`)
      continue
    }
    if (name === "auth" || name === "permission" || name === "service" || name === "cancelled") {
      const kind = name === "service" ? "provider-unavailable" : name === "cancelled" ? "unknown" : name
      world.result(calls[0]!, { kind: "failed", reason: "Synthetic native failure", failureEvidence: { kind, source: "native-error" }, ...(name === "cancelled" && { cancelled: true }) })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(calls.length, 1, "an external cause or explicit cancellation is not a broken summary")
      assert.equal(owner.snapshot(id)!.control!.compactionRecovery, undefined)
      const request = owner.snapshot(id)!.requests.find(request => request.id === queued)!
      if (name === "auth") assert.ok(request.signIn, "the existing verified-sign-in hold owns pending work")
      if (name === "permission") assert.equal(request.failure, "permission")
      if (name === "service") assert.equal(request.retry?.cause, "provider-unavailable")
      console.log(`PASS: compaction ${name}`)
      continue
    }
    world.fail(calls[0]!)
    await until("one verified retry", () => calls.length === 2)
    if (name === "retry-uncertain-late") {
      world.result(calls[1]!, { kind: "uncertain", reason: "Native summary is still unconfirmed" })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(calls.length, 2, "uncertainty never repeats the compact command")
      assert.equal(world.prompts.length, 0, "unknown compact keeps the queue from racing it")
      world.result(calls[1]!, { kind: "completed" })
      await until("the exact late native completion releases the queue", () => owner.snapshot(id)!.requests.find(request => request.id === queued)?.status === "completed")
      assert.equal(world.prompts.length, 1)
      assert.equal(world.launches.length, 1)
    } else if (name === "stop") {
      await owner.cancel(id)
      world.fail(calls[1]!)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(world.launches.length, 1)
      const waiting = owner.snapshot(id)!.requests.find(request => request.id === queued)!
      assert.equal(waiting.pause, "stop")
      assert.equal(waiting.status, "held")
      assert.equal(owner.snapshot(id)!.control!.compactionRecovery!.state.kind, "withdrawn")
    } else if (name === "close-open") {
      await owner.close(id)
      assert.equal(owner.snapshot(id)!.requests.find(request => request.id === queued)!.status, "queued", "Close must not become Stop for ordinary queued words")
      assert.equal(world.prompts.length, 0)
      const reopening = randomUUID()
      owner.submit(id, reopening, "new message reopens the conversation")
      await until("reopening sends kept words once without Resume", () => owner.snapshot(id)!.requests.find(request => request.id === queued)?.status === "completed")
      await until("the new input follows the old queue", () => owner.snapshot(id)!.requests.find(request => request.id === reopening)?.status === "completed")
      assert.equal(world.prompts.length, 2)
      assert.ok(world.prompts[0]!.text.endsWith("kept queued work"), "the first kept message carries the transcript once")
      assert.equal(world.prompts[1]!.text, "new message reopens the conversation")
      assert.notEqual(owner.snapshot(id)!.control!.activeBindingId, binding)
      assert.equal(world.launches[1]!.resume, undefined, "a known failed context is replaced at reopen, not resumed")
      await owner.act(id, { kind: "compact", id: randomUUID() })
      assert.equal(calls.length, 3, "a retired binding's unknown compact cannot block a later compact on the replacement")
    } else if (name === "late-result") {
      world.fail(calls[1]!)
      await until("replacement queue completed", () => owner.snapshot(id)!.requests.find(request => request.id === queued)?.status === "completed")
      const replacement = owner.snapshot(id)!.control!.activeBindingId
      world.result(calls[0]!, { kind: "completed" })
      world.result(calls[1]!, { kind: "completed" })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(owner.snapshot(id)!.control!.activeBindingId, replacement)
      assert.equal(world.prompts.length, 1)
      assert.equal(world.launches.length, 2)
    } else {
      world.result(calls[1]!, { kind: "completed" })
      if (name === "unreceived-work") {
        await until("a proven unreceived request goes as itself", () => owner.snapshot(id)!.requests.find(request => request.id === original)?.status === "completed")
        assert.equal(world.prompts.length, 1)
        assert.equal(world.prompts[0]!.text, "original work with possible prior effects")
        assert.equal(owner.snapshot(id)!.requests.filter(request => request.id === original).length, 1)
        assert.ok(!owner.snapshot(id)!.requests.some(request => request.continues?.requestId === original), "do not replace an unheard task with an empty continuation")
      } else if (name === "failed-work") {
        await until("the original accepted work gets a linked discovery continuation", () => owner.snapshot(id)!.requests.some(request => request.continues?.requestId === original && request.status === "completed"))
        assert.equal(world.prompts.filter(prompt => prompt.text.includes("original work with possible prior effects")).length, 1, "accepted original work is never replayed")
        assert.match(world.prompts[1]!.text, /check|inspect/i)
        assert.equal(world.prompts.length, 2)
      } else await until("retry success releases the queue", () => owner.snapshot(id)!.requests.find(request => request.id === queued)?.status === "completed")
      assert.equal(world.launches.length, 1, "successful compact retry keeps the original native session")
    }
    console.log(`PASS: compaction ${name}`)
  } catch (error) {
    const snapshot = owner.snapshot(id)
    console.error(JSON.stringify({ name, calls, prompts: world.prompts, control: snapshot?.control, requests: snapshot?.requests, logs: world.logs }))
    throw error
  } finally { await world.close(); rmSync(root, { recursive: true, force: true }) }
}

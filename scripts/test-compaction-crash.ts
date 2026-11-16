import { z } from "zod"
import { CompactionRecoverySchema } from "@mako/host/contracts/conversation-control"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { compactionWorld } from "./lib/compaction-world.ts"

async function until(why: string, check: () => boolean) {
  const end = performance.now() + 5_000
  while (!check()) { assert.ok(performance.now() < end, why); await new Promise(resolve => setTimeout(resolve, 5)) }
}
const phases = ["before-retry", "replacement", "prepared-replacement", "committed-replacement", "off"] as const
const ChildArgsSchema = z.tuple([z.string().min(1), z.string().uuid(), z.enum(phases)])
const CheckpointSchema = z.object({ phase: z.enum(phases), recovery: CompactionRecoverySchema })
const child = process.argv.indexOf("--child")
if (child !== -1) {
  const [root, id, phase] = ChildArgsSchema.parse(process.argv.slice(child + 1))
  let armed = false
  const world = compactionWorld(root, { id, emit: () => {
    if (!armed) return
    const control = world.owner.snapshot(id)?.control, recovery = control?.compactionRecovery
    const hit = phase === "before-retry" || phase === "off" ? recovery?.state.kind === "retry" && !control?.actions?.some(action => action.input.id === recovery.retryActionId)
      : phase === "replacement" ? recovery?.state.kind === "replace" && !control?.transfers.length
        : phase === "prepared-replacement" ? control?.transfers.some(transfer => transfer.compaction && transfer.state.kind === "preparing")
        : phase === "committed-replacement" ? recovery?.state.kind === "completed" && Boolean(recovery.state.waiting?.length)
        : false
    if (!hit) return
    writeFileSync(join(root, "checkpoint.tmp"), JSON.stringify({ phase, recovery }))
    renameSync(join(root, "checkpoint.tmp"), join(root, "checkpoint.json"))
    process.kill(process.pid, "SIGSTOP")
  } })
  await world.start()
  if (phase === "off") world.owner.setConversationSettings({ continueAfterRestart: false })
  await world.owner.act(id, { kind: "compact", id: randomUUID() })
  world.owner.submit(id, randomUUID(), "first after crash")
  world.owner.submit(id, randomUUID(), "second after crash")
  armed = true
  world.fail(world.calls[0]!)
  if (["replacement", "prepared-replacement", "committed-replacement"].includes(phase)) {
    await until("child compact retry starts", () => world.calls.length === 2)
    world.fail(world.calls[1]!)
    await new Promise(() => {})
  }
  throw new Error("child did not stop at its commit boundary")
} else {
  for (const phase of phases) {
    const root = mkdtempSync(join(tmpdir(), `mako-compact-crash-${phase}-`)), id = randomUUID()
    const processUnderTest = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--child", root, id, phase], { stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    processUnderTest.stderr.on("data", chunk => { output += chunk })
    let world: ReturnType<typeof compactionWorld> | undefined
    try {
      await until(`child reaches durable ${phase} boundary: ${output}`, () => existsSync(join(root, "checkpoint.json")))
      const exit = new Promise(resolve => processUnderTest.once("exit", resolve))
      processUnderTest.kill("SIGKILL")
      await exit
      const saved = CheckpointSchema.parse(JSON.parse(readFileSync(join(root, "checkpoint.json"), "utf8")))
      world = compactionWorld(root, { id })
      const restored = world.owner.snapshot(id)!
      assert.equal(restored.control!.compactionRecovery!.id, saved.recovery.id, "restart uses the original episode")
      const requests = restored.requests.map(request => request.id)
      if (phase === "off") {
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(world.calls.length, 0)
        assert.equal(world.launches.length, 0)
        assert.equal(world.prompts.length, 0)
        assert.equal(world.owner.snapshot(id)!.control!.compactionRecovery!.state.kind, "withdrawn")
      } else {
        if (phase === "before-retry") {
          await until("restart issues its one recorded retry", () => world!.calls.length === 1)
          assert.equal(world.calls[0]!.action, saved.recovery.retryActionId)
          world.fail(world.calls[0]!)
        } else assert.equal(world.calls.length, 0, "replacement never repeats either old compact command")
        await until("restart drains original queue in a fresh binding", () => world!.owner.snapshot(id)!.requests.every(request => request.status === "completed"))
        assert.deepEqual(world.owner.snapshot(id)!.requests.map(request => request.id), requests)
        assert.equal(world.prompts.length, 2)
        assert.ok(world.prompts[0]!.text.endsWith("first after crash"))
        assert.equal(world.prompts[1]!.text, "second after crash")
        const fresh = world.launches.at(-1)!
        if (phase !== "committed-replacement") assert.equal(fresh.resume, undefined)
        else assert.notEqual(world.owner.snapshot(id)!.control!.activeBindingId, saved.recovery.bindingId, "restart only resumes the committed replacement, never the failed source")
        assert.equal(fresh.fork, undefined)
      }
      console.log(`PASS: actual process crash at ${phase}; journal identity, request order and restart policy retained`)
    } catch (error) { console.error(output, world && JSON.stringify({ calls: world.calls, launches: world.launches, logs: world.logs, snapshot: world.owner.snapshot(id) })); throw error }
    finally {
      if (processUnderTest.exitCode === null && processUnderTest.signalCode === null) processUnderTest.kill("SIGKILL")
      await world?.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

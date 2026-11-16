import { mock } from "node:test"
import { COMPACTION_CONFIRMATION_MS } from "@mako/host/contracts/recovery"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { CompactionRecoverySchema } from "@mako/host/contracts/conversation-control"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { compactionWorld } from "./lib/compaction-world.ts"

async function until(why: string, check: () => boolean, timeoutMs = 5_000) {
  const end = performance.now() + timeoutMs
  while (!check()) { assert.ok(performance.now() < end, why); await new Promise(resolve => setTimeout(resolve, 5)) }
}
const phases = ["before-retry", "replacement", "prepared-replacement", "committed-replacement", "off", "uncertain", "uncertain-off", "native"] as const
const ChildArgsSchema = z.tuple([z.string().min(1), z.string().uuid(), z.enum(phases)])
const CheckpointSchema = z.object({ phase: z.enum(phases), recovery: CompactionRecoverySchema, at: z.string().regex(/^\d+$/) })
const child = process.argv.indexOf("--child")
if (child !== -1) {
  const [root, id, phase] = ChildArgsSchema.parse(process.argv.slice(child + 1))
  const bootPause = Number(process.env.MAKO_COMPACTION_CRASH_BOOT_PAUSE_MS ?? 0)
  const phasePause = Number(process.env.MAKO_COMPACTION_CRASH_PHASE_PAUSE_MS ?? 0)
  assert.ok([bootPause, phasePause].every(ms => Number.isInteger(ms) && ms >= 0 && ms <= 10_000))
  if (bootPause) await new Promise(resolve => setTimeout(resolve, bootPause))
  const startedAt = performance.now()
  const stage = (name: string) => {
    const value = { name, elapsed: performance.now() - startedAt, uptime: performance.now(), monotonic: String(process.hrtime.bigint()), cpu: process.cpuUsage() }
    writeFileSync(join(root, "child-stage.json"), JSON.stringify(value))
    appendFileSync(join(root, "child-stages.jsonl"), JSON.stringify(value) + "\n")
  }
  stage("loaded")
  const begin = async () => {
    stage("fixture-ready")
    writeFileSync(join(root, "ready"), "ready")
    await until("parent starts the crash phase", () => existsSync(join(root, "begin")), 30_000)
    stage("phase-started")
    if (phasePause) await new Promise(resolve => setTimeout(resolve, phasePause))
  }
  let armed = false
  const world = compactionWorld(root, { id, automatic: phase === "native", launch: { tuning: { model: "fixture-model" } }, emit: () => {
    if (!armed) return
    const control = world.owner.snapshot(id)?.control, recovery = control?.compactionRecovery
    const unknownAction = recovery?.state.kind === "reconcile" ? recovery.state.actionId : undefined
    const hit = phase === "uncertain" || phase === "uncertain-off" ? recovery?.origin !== "native" && recovery?.state.kind === "reconcile" && control?.actions?.some(action => action.input.id === unknownAction && action.state.kind === "uncertain")
      : phase === "native" ? recovery?.origin === "native" && recovery.state.kind === "replace"
      : phase === "before-retry" || phase === "off" ? recovery?.origin !== "native" && recovery?.state.kind === "retry" && !control?.actions?.some(action => action.input.id === recovery.retryActionId)
      : phase === "replacement" ? recovery?.state.kind === "replace" && !control?.transfers.length
        : phase === "prepared-replacement" ? control?.transfers.some(transfer => transfer.compaction && transfer.state.kind === "preparing")
        : phase === "committed-replacement" ? recovery?.state.kind === "completed" && Boolean(recovery.state.waiting?.length)
        : false
    if (!hit) return
    writeFileSync(join(root, "checkpoint.tmp"), JSON.stringify({ phase, recovery, at: String(process.hrtime.bigint()) }))
    renameSync(join(root, "checkpoint.tmp"), join(root, "checkpoint.json"))
    process.kill(process.pid, "SIGSTOP")
  } })
  stage("constructed")
  await world.start()
  stage("started")
  if (phase === "off" || phase === "uncertain-off") world.owner.setConversationSettings({ continueAfterRestart: false })
  if (phase === "native") {
    world.control.failPrompt = true
    await begin()
    armed = true
    world.owner.submit(id, randomUUID(), "accepted native work before failure")
    await new Promise(() => {})
  }
  await world.owner.act(id, { kind: "compact", id: randomUUID() })
  world.owner.submit(id, randomUUID(), "first after crash")
  world.owner.submit(id, randomUUID(), "second after crash")
  await begin()
  armed = true
  stage("armed")
  if (phase === "uncertain" || phase === "uncertain-off") {
    world.result(world.calls[0]!, { kind: "uncertain", reason: "Lost response before host crash" })
    stage("uncertain-recorded")
    await new Promise(() => {})
  }
  world.fail(world.calls[0]!)
  if (["replacement", "prepared-replacement", "committed-replacement"].includes(phase)) {
    await until("child compact retry starts", () => world.calls.length === 2)
    world.fail(world.calls[1]!)
    await new Promise(() => {})
  }
  throw new Error("child did not stop at its commit boundary")
} else {
  for (const phase of phases) {
    if (process.argv.some(arg => arg.startsWith("--case=")) && !process.argv.includes(`--case=${phase}`)) continue
    const root = mkdtempSync(join(tmpdir(), `mako-compact-crash-${phase}-`)), id = randomUUID()
    const spawnedAt = process.hrtime.bigint()
    const processUnderTest = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--child", root, id, phase], { stdio: ["ignore", "pipe", "pipe"] })
    const exited = new Promise<void>(resolve => processUnderTest.once("exit", () => resolve()))
    let output = ""
    processUnderTest.stdout.resume()
    processUnderTest.stderr.on("data", chunk => { output += chunk })
    let world: ReturnType<typeof compactionWorld> | undefined
    try {
      // Module loading and fixture construction precede the operation under test. Do not spend its five seconds on bootstrap.
      await until(`child prepares ${phase}: ${output}`, () => existsSync(join(root, "ready")), 30_000)
      const beganAt = process.hrtime.bigint()
      writeFileSync(join(root, "begin"), "begin")
      await until(`child reaches durable ${phase} boundary: ${output}`, () => existsSync(join(root, "checkpoint.json")))
      processUnderTest.kill("SIGKILL")
      await exited
      const saved = CheckpointSchema.parse(JSON.parse(readFileSync(join(root, "checkpoint.json"), "utf8")))
      const phaseMs = Number(BigInt(saved.at) - beganAt) / 1e6
      assert.ok(phaseMs >= 0 && phaseMs <= 5_000, `durable ${phase} checkpoint exceeded five seconds: ${phaseMs} ms`)
      if (process.env.MAKO_COMPACTION_CRASH_DIAGNOSTICS) appendFileSync(process.env.MAKO_COMPACTION_CRASH_DIAGNOSTICS, JSON.stringify({ phase, phaseToCheckpointMs: phaseMs, spawnToCheckpointMs: Number(process.hrtime.bigint() - spawnedAt) / 1e6, stages: existsSync(join(root, "child-stages.jsonl")) ? readFileSync(join(root, "child-stages.jsonl"), "utf8") : "not-loaded" }) + "\n")
      world = compactionWorld(root, { id, automatic: phase === "native" })
      const restored = world.owner.snapshot(id)!
      assert.equal(restored.control!.compactionRecovery!.id, saved.recovery.id, "restart uses the original episode")
      if (phase === "uncertain" || phase === "uncertain-off") assert.deepEqual(restored.control!.compactionRecovery!.state, saved.recovery.state, "restart preserves the original confirmation deadline, not a new five-minute budget")
      const requests = restored.requests.map(request => request.id)
      if (phase === "off" || phase === "uncertain-off") {
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(world.calls.length, 0)
        assert.equal(world.launches.length, 0)
        assert.equal(world.prompts.length, 0)
        assert.equal(world.owner.snapshot(id)!.control!.compactionRecovery!.state.kind, "withdrawn")
      } else if (phase === "native") {
        await until("native episode survives a crash without inventing a compact command", () => world!.owner.snapshot(id)!.requests.some(request => request.continues?.reason === "compaction-failed" && request.status === "completed"))
        assert.equal(world.calls.length, 0)
        assert.equal(world.prompts.length, 1)
        assert.doesNotMatch(world.prompts[0]!.text, /accepted native work before failure/)
        assert.equal(world.launches[0]!.resume, undefined)
      } else {
        if (phase === "uncertain") {
          await new Promise(resolve => setImmediate(resolve))
          assert.equal(world.calls.length, 0)
          assert.equal(world.launches.length, 0, "a restart does not restart the deadline or compact")
          mock.timers.enable({ apis: ["Date"], now: saved.recovery.createdAt + COMPACTION_CONFIRMATION_MS + 1 })
          world.owner.wakeDue(Date.now())
        }
        if (phase === "before-retry") {
          await until("restart issues its one recorded retry", () => world!.calls.length === 1)
          assert.equal(world.calls[0]!.action, saved.recovery.origin !== "native" && saved.recovery.retryActionId)
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
    } catch (error) {
      const stagePath = join(root, "child-stage.json"), journalPath = join(root, "journals", `${id}.sqlite`)
      const stage = existsSync(stagePath) ? readFileSync(stagePath, "utf8") : "not-loaded"
      let metadata: string | undefined
      if (existsSync(journalPath)) {
        const journal = new DatabaseSync(journalPath, { readOnly: true })
        try { metadata = String(journal.prepare("SELECT value FROM metadata WHERE id=1").get()?.value) } finally { journal.close() }
      }
      console.error(JSON.stringify({ phase, stage, metadata, output }), world && JSON.stringify({ calls: world.calls, launches: world.launches, logs: world.logs, snapshot: world.owner.snapshot(id) }))
      throw error
    }
    finally {
      mock.timers.reset()
      if (processUnderTest.exitCode === null && processUnderTest.signalCode === null) processUnderTest.kill("SIGKILL")
      await exited
      await world?.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

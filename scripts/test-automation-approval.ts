import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Git } from "@mako/git"
import { z } from "zod"
import { AgentAskGate } from "@mako/host/conversations/agent-ask-gate"
import { AutomationTool } from "@mako/host/conversations/automation-tool"
import { Automations } from "@mako/host/workspaces/automations"
import { AutomationLaunches, AutomationNotStartedError, UNKNOWN_AUTOMATION_LAUNCH } from "@mako/host/workspaces/automation-launches"
import { invokeWithRecovery } from "@mako/host/contracts/host-call-recovery"
import { RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"
import { hostCallReplay } from "@mako/host/contracts/host-call-policy"
import { AgentsWorld } from "./lib/agents-world"

// Only synthetic launches in owned scratch hosts; SIGKILL targets this test's own child, never a provider or profile.
async function compose(root: string, conversation: string, launch: () => Promise<void>) {
  const world = new AgentsWorld({ root, script: () => "ok" })
  const git = new Git()
  const service = new Automations({ git, watch: async () => ({ unsubscribe: async () => {} }), emit: () => {}, launch, launches: new AutomationLaunches(join(root, "launch-receipts")) })
  await service.watch(root)
  const gate = new AgentAskGate(world.live.asks)
  const tool = new AutomationTool({ gate, conversationOf: () => conversation, tier: () => "auto", invoke: async (channel, args) => {
    if (channel === "mako:automation-context") return z.json().parse(service.context())
    if (channel === "mako:run-automation") return z.json().parse(await service.fire(String(args[0]), "manual", z.string().optional().parse(args[1]), z.string().optional().parse(args[2])))
    return z.json().parse(channel === "mako:automations" ? service.list() : service.setEnabled(String(args[0]), Boolean(args[1]), z.string().optional().parse(args[2])))
  } })
  gate.runs.automation = (id, want, ask) => tool.allowed(id, want, ask)
  return { world, service, gate, tool, close: async () => { service.stop(); await git.close(); await world.close() } }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mako-approval-launch-"))
  mkdirSync(join(root, ".mako"))
  writeFileSync(join(root, ".mako", "automations.json"), JSON.stringify({ automations: ["one", "two"].map(id => ({ id, name: id, prompt: "Synthetic fixture", trigger: "manual" })) }))
  writeFileSync(join(root, "launches.log"), "")
  return root
}
const count = (root: string) => readFileSync(join(root, "launches.log"), "utf8").split("\n").filter(Boolean).length

if (process.argv[2] === "--child") {
  const [root, conversation, ask, crash] = process.argv.slice(3)
  assert.ok(root && conversation && ask)
  const current = await compose(root, conversation, async () => {
    appendFileSync(join(root, "launches.log"), "launch\n")
    if (crash === "during") process.kill(process.pid, "SIGKILL")
  })
  try {
    assert.equal(current.gate.open(conversation).filter(each => each.id === ask).length, 1, "the exact durable ask recovered")
    current.gate.runs.automation = async (id, want, ask) => {
      await current.tool.allowed(id, want, ask)
      if (crash === "after") process.kill(process.pid, "SIGKILL")
    }
    try {
      await current.gate.answer(conversation, ask, true)
      assert.equal(current.gate.open(conversation).length, 0)
    } catch (error) {
      assert.ok(error instanceof Error && error.message === UNKNOWN_AUTOMATION_LAUNCH)
      assert.equal(current.gate.open(conversation).length, 1, "uncertainty preserves the exact ask without granting another launch")
      process.exitCode = 2
    }
  } finally { await current.close() }
} else {
  assert.equal(hostCallReplay("mako:automations-act"), "never", "direct launches remain non-replayable")
  for (const crash of ["after", "during"] as const) {
    const root = fixture()
    try {
      const initial = new AgentsWorld({ root, script: () => "ok" })
      const apex = await initial.apex("codex", "auto")
      await initial.settle(100)
      const gate = new AgentAskGate(initial.live.asks)
      const ask = gate.ask(apex.conversation, { kind: "automation", action: "run", id: "one", cwd: root })
      await initial.close()
      const run = (mode: string) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--child", root, apex.conversation, ask.id, mode], { stdio: "inherit" })
        child.once("error", reject)
        child.once("exit", (code, signal) => resolve({ code, signal }))
      })
      const attempts: number[] = []
      const recovery = () => invokeWithRecovery("mako:agent-ask-answer", async attempt => {
        attempts.push(attempt)
        const result = await run(attempt === 1 ? crash : "replay")
        if (attempt === 1) { assert.equal(result.signal, "SIGKILL"); throw new RuntimeDisconnectedError(true) }
        if (result.code === 2) throw new Error(UNKNOWN_AUTOMATION_LAUNCH)
        assert.equal(result.code, 0)
      }, { dropped: async () => true })
      if (crash === "after") await recovery()
      else {
        await assert.rejects(recovery(), RuntimeDisconnectedError)
        assert.equal((await run("explicit-retry")).code, 2, "a later click cannot relaunch an uncertain action")
      }
      assert.deepEqual(attempts, [1, 2])
      assert.equal(count(root), 1, "actual recovery across an owned SIGKILL launches once")
      console.log(`automation approval: ${crash} launch SIGKILL, attempts[1,2], one launch${crash === "during" ? ", explicit retry held unknown" : ", saved completion settled recovered ask"}`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  const root = fixture()
  try {
    const initial = new AgentsWorld({ root, script: () => "ok" })
    const apex = await initial.apex("codex", "auto")
    await initial.settle(100)
    await initial.close()
    let fail = true
    let current = await compose(root, apex.conversation, async () => {
      if (fail) throw new AutomationNotStartedError("No provider is available")
      appendFileSync(join(root, "launches.log"), "launch\n")
    })
    const result = await current.tool.act({ kind: "agent", session: "own" }, { action: "run", id: "one", clientKey: "retry" })
    assert.ok("ask" in result)
    const exact = structuredClone(current.gate.open(apex.conversation))
    await assert.rejects(current.gate.answer(apex.conversation, result.ask, true), /No provider/)
    assert.deepEqual(current.gate.open(apex.conversation), exact)
    assert.equal(count(root), 0)
    await current.close()
    fail = false
    current = await compose(root, apex.conversation, async () => { appendFileSync(join(root, "launches.log"), "launch\n") })
    try {
      assert.deepEqual(current.gate.open(apex.conversation), exact)
      await Promise.all([current.gate.answer(apex.conversation, result.ask, true), current.gate.answer(apex.conversation, result.ask, true)])
      await current.gate.answer(apex.conversation, result.ask, true)
      assert.equal(count(root), 1, "known preflight refusal retries once after restart; concurrent and successful duplicate answers join")
      const another = await current.tool.act({ kind: "agent", session: "own" }, { action: "run", id: "two", clientKey: "different" })
      assert.ok("ask" in another)
      await current.gate.answer(apex.conversation, another.ask, true)
      assert.equal(count(root), 2, "a distinct approved automation still runs")
      const receipts = new AutomationLaunches(join(root, "admission"))
      let launches = 0
      const launch = async () => { launches++; return { status: "completed" as const } }
      await Promise.all([receipts.run("same", { cwd: root, id: "one" }, launch), new AutomationLaunches(join(root, "admission")).run("same", { cwd: root, id: "one" }, launch)])
      assert.equal(launches, 1, "two ledger instances share durable admission")
      assert.equal((await receipts.run("same", { cwd: root, id: "two" }, launch)).status, "not-run", "an operation cannot widen to another automation")
      assert.equal(launches, 1)
      writeFileSync(join(root, "admission", `${createHash("sha256").update("broken").digest("hex")}.json`), "not json")
      await assert.rejects(receipts.run("broken", { cwd: root, id: "one" }, launch))
      assert.equal(launches, 1, "an unreadable receipt never grants another launch")
      const unrecordedGit = new Git()
      const unrecorded = new Automations({ git: unrecordedGit, watch: async () => ({ unsubscribe: async () => {} }), emit: () => {}, launch: async () => { launches++ } })
      try {
        await unrecorded.watch(root)
        assert.equal((await unrecorded.fire("one", "manual", "no-ledger")).status, "not-run")
        assert.equal(launches, 1, "missing durable admission fails closed")
      } finally { unrecorded.stop(); await unrecordedGit.close() }
    } finally { await current.close() }
    console.log("automation approval: known preflight refusal/restart/concurrent retry, duplicate success, distinct automation and durable admission passed")
  } finally { rmSync(root, { recursive: true, force: true }) }
}

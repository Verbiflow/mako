import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AgentAskGate } from "@mako/host/conversations/agent-ask-gate"
import { AutomationTool } from "@mako/host/conversations/automation-tool"
import { hostCallReplay } from "@mako/host/contracts/host-call-policy"
import { AutomationStore } from "@mako/host/workspaces/automation-store"
import { Automations } from "@mako/host/workspaces/automations"
import { AgentsWorld } from "./lib/agents-world"

/**
 * An approved run's durability: the person allows an agent's run_now, and the host is killed (SIGKILL, this test's own
 * child only) while the run's Thread starts or just after. Answering the same ask again in the next host reaches the
 * same run and the same Thread (its conversation is fixed by `automation:<id>:<occurrence>`), never a second; the
 * exact ask is kept until an answer settles it. A proposal pending when a host dies is still pending in the next, its
 * ask still in the agent's conversation, and approving it applies it once.
 */

const self = fileURLToPath(import.meta.url)

function compose(root: string, conversation: string, onStart: (conversationId: string) => void) {
  const world = new AgentsWorld({ root, script: () => "ok" })
  const gate = new AgentAskGate(world.live.asks)
  const automations = new Automations({
    store: new AutomationStore(join(root, "automations")),
    scheduler: { start: () => () => {} },
    emit: () => {},
    openProjects: () => [root],
    startThread: async (launch) => {
      onStart(launch.conversationId)
      return {}
    },
    threadOf: () => ({ state: "working" }),
    stopThread: async () => {},
    runGate: async () => ({ exit: 0, stdout: "", stderr: "" }),
    head: async () => undefined,
    tell: async () => {},
    asks: { raise: (id, want) => gate.ask(id, want).id, settle: (id, ask) => void world.live.asks.settle(id, ask) },
  })
  const tool = new AutomationTool({ gate, conversationOf: () => conversation, tier: () => "auto", folderOf: () => root, automations: () => automations })
  gate.runs = { automation: (id, want, ask) => tool.allowed(id, want, ask), "automation-proposal": async (_id, want) => tool.proposalAllowed(want) }
  return { world, gate, tool, automations, close: async () => { automations.stop(); await world.close() } }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mako-approval-launch-"))
  mkdirSync(join(root, ".mako"))
  writeFileSync(join(root, ".mako", "automations.json"), JSON.stringify({ version: 2, automations: ["one", "two"].map((id) => ({ id, name: id, prompt: { objective: "Synthetic fixture" } })) }))
  writeFileSync(join(root, "launches.log"), "")
  return root
}
const launches = (root: string) => readFileSync(join(root, "launches.log"), "utf8").split("\n").filter(Boolean)
const logLaunch = (root: string) => (id: string) => appendFileSync(join(root, "launches.log"), `${id}\n`)

if (process.argv[2] === "--child") {
  const [root, conversation, ask, crash] = process.argv.slice(3)
  assert.ok(root && conversation && ask && crash)
  const current = compose(root, conversation, (id) => {
    logLaunch(root)(id)
    if (crash === "during") process.kill(process.pid, "SIGKILL")
  })
  try {
    assert.equal(current.gate.open(conversation).filter((each) => each.id === ask).length, 1, "the exact durable ask recovered")
    current.gate.runs.automation = async (id, want, askId) => {
      await current.tool.allowed(id, want, askId)
      if (crash === "after") process.kill(process.pid, "SIGKILL")
    }
    await current.gate.answer(conversation, ask, true)
  } finally {
    await current.close()
  }
} else {
  assert.equal(hostCallReplay("mako:automations-act"), "never", "an agent's direct calls are never replayed blind")
  assert.equal(hostCallReplay("mako:automations-run-now"), "replay", "Run now is settled by its key")
  const run = (args: string[]) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", self, "--child", ...args], { stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  for (const crash of ["during", "after"] as const) {
    const root = fixture()
    try {
      const initial = new AgentsWorld({ root, script: () => "ok" })
      const apex = await initial.apex("codex", "auto")
      const gate = new AgentAskGate(initial.live.asks)
      const ask = gate.ask(apex.conversation, { kind: "automation", action: "run", id: "one", cwd: root })
      await initial.close()
      const killed = await run([root, apex.conversation, ask.id, crash])
      assert.equal(killed.signal, "SIGKILL")
      assert.equal(launches(root).length, 1)
      // The next host: the same answer again.
      const replay = compose(root, apex.conversation, logLaunch(root))
      try {
        assert.equal(replay.gate.open(apex.conversation).filter((each) => each.id === ask.id).length, 1, "the killed host left the exact ask")
        await replay.gate.answer(apex.conversation, ask.id, true)
        assert.equal(replay.gate.open(apex.conversation).length, 0, "the answer settles it")
        assert.equal(new Set(launches(root)).size, 1, "every start of the approved run is the same Thread")
        assert.deepEqual(replay.automations.runs(root, "one").map((each) => each.status), ["fired"], "one run")
        // A different approved automation still runs, as its own Thread.
        const another = await replay.tool.act({ kind: "agent", session: "own" }, { action: "run_now", id: "two", clientKey: "different" })
        assert.ok("outcome" in another && another.outcome === "asked")
        await replay.gate.answer(apex.conversation, another.ask, true)
        assert.equal(new Set(launches(root)).size, 2)
      } finally {
        await replay.close()
      }
      console.log(`automation approval: SIGKILL ${crash} the launch, answered again: one run, one Thread`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  const root = fixture()
  try {
    const first = compose(root, "", () => {})
    const apex = await first.world.apex("codex", "auto")
    const proposed = await first.automations.propose({ conversation: apex.conversation }, { project: root, change: "create", definition: { id: "three", name: "Three", prompt: { objective: "Three" } }, clientKey: "k" })
    assert.ok(!("refused" in proposed) && proposed.status === "pending")
    await first.close()
    const second = compose(root, apex.conversation, () => {})
    try {
      await second.automations.start()
      assert.equal(second.automations.proposal(proposed.id)?.status, "pending", "kept across the restart")
      const [ask] = second.gate.open(apex.conversation)
      assert.ok(ask?.want.kind === "automation-proposal", "its ask is still in the agent's conversation")
      await Promise.all([second.gate.answer(apex.conversation, ask.id, true), second.gate.answer(apex.conversation, ask.id, true)])
      assert.equal(second.automations.proposal(proposed.id)?.status, "approved")
      assert.deepEqual((await second.automations.reading(root)).automations.map((each) => each.definition.id), ["one", "two", "three"], "applied once")
    } finally {
      await second.close()
    }
    console.log("automation approval: a pending proposal survives a restart and is applied once")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

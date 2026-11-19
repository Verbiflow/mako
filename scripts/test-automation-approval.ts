import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AgentAskGate } from "@mako/host/conversations/agent-ask-gate"
import { AGENT_ASK_ALLOW, AGENT_ASK_KEEP } from "@mako/host/contracts/agent-asks"
import { AutomationTool } from "@mako/host/conversations/automation-tool"
import { hostCallReplay } from "@mako/host/contracts/host-call-policy"
import { AutomationDefinitionSchema, automationFingerprint } from "@mako/host/contracts/automations"
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
  gate.runs = { automation: (id, want, ask) => tool.allowed(id, want, ask), "automation-proposal": async () => tool.proposalAllowed() }
  return { world, gate, tool, automations, close: async () => { automations.stop(); await world.close() } }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mako-approval-launch-"))
  mkdirSync(join(root, ".mako"))
  writeFileSync(join(root, ".mako", "automations.json"), JSON.stringify({ version: 2, automations: ["one", "two"].map((id) => ({ id, name: id, prompt: { objective: "Synthetic fixture" } })) }))
  writeFileSync(join(root, "launches.log"), "")
  // The person approved both (as turning them on would): an agent's run is of the definition they approved, or none.
  const approved = (id: string) => {
    const definition = AutomationDefinitionSchema.parse({ id, name: id, prompt: { objective: "Synthetic fixture" } })
    return [id, { local: { enabled: false, failures: 0, approved: automationFingerprint(definition), approvedDefinition: definition }, runs: [] }]
  }
  mkdirSync(join(root, "automations"))
  writeFileSync(join(root, "automations", "state.json"), JSON.stringify({ version: 1, projects: { [root]: { automations: Object.fromEntries(["one", "two"].map(approved)) } }, proposals: [] }))
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
      // Approved where its change is shown (Automations, the Inbox's card), twice at once: applied once.
      await Promise.all([second.automations.decide(proposed.id, true), second.automations.decide(proposed.id, true)])
      assert.equal(second.automations.proposal(proposed.id)?.status, "approved")
      assert.deepEqual((await second.automations.reading(root)).automations.map((each) => each.definition.id), ["one", "two", "three"], "applied once")
    } finally {
      await second.close()
    }
    console.log("automation approval: a pending proposal survives a restart and is applied once")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  // An agent's proposal, as a Fin's ask reaches its Apex and the person (`LiveAsks.pending`): only Decline and the way to
  // its change; an allow sent through it anyway (`LiveAsks.answer`, as `agents_answer` and a phone's card send it) is
  // refused and applies nothing.
  const fin = fixture()
  try {
    const host = compose(fin, "", () => {})
    try {
      host.world.live.asks.answering = async (conversation, ask, allow) => void (await host.gate.answer(conversation, ask, allow))
      // As the host wires a refusal: the tool that keeps the proposal hears it.
      host.gate.declined = async (_conversation, want) => {
        if (want.kind === "automation-proposal") await host.tool.proposalDeclined(want)
      }
      const agent = await host.world.apex("codex", "auto")
      const proposed = await host.automations.propose({ conversation: agent.conversation }, { project: fin, change: "enable", id: "one", clientKey: "e" })
      assert.ok(!("refused" in proposed))
      const pending = host.world.live.asks.pending(agent.conversation)
      assert.deepEqual(pending?.options.map((option) => option.optionId), [AGENT_ASK_KEEP], "only Decline")
      assert.deepEqual(pending?.review, { project: fin, automation: "one", proposal: proposed.id }, "and where its change is shown")
      await assert.rejects(host.world.live.asks.answer(agent.conversation, pending!.request, { kind: "choice", optionId: AGENT_ASK_ALLOW }), /approved where its change is shown/)
      assert.equal(host.automations.proposal(proposed.id)?.status, "pending")
      assert.equal((await host.automations.reading(fin)).automations.find((each) => each.definition.id === "one")?.local.enabled, false, "nothing applied")
      await host.world.live.asks.answer(agent.conversation, pending!.request, { kind: "choice", optionId: AGENT_ASK_KEEP })
      assert.equal(host.automations.proposal(proposed.id)?.status, "declined", "Decline still answers it")
    } finally {
      await host.close()
    }
    console.log("automation approval: a proposal's ask only declines; an allow through it is refused and applies nothing")
  } finally {
    rmSync(fin, { recursive: true, force: true })
  }
}

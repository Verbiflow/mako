import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { z } from "zod"
import { AgentAskGate } from "@mako/host/conversations/agent-ask-gate"
import { AutomationTool } from "@mako/host/conversations/automation-tool"
import { Automations } from "@mako/host/workspaces/automations"
import { AutomationLaunches, AutomationNotStartedError } from "@mako/host/workspaces/automation-launches"
import { AgentsWorld } from "./lib/agents-world"

const root = mkdtempSync(join(tmpdir(), "mako-automation-owner-"))
const git = new Git()
let world = new AgentsWorld({ root, script: () => "ok" })
const launches: { cwd: string; prompt: string }[] = []
let preflightRefuses = false
const service = new Automations({ git, watch: async () => ({ unsubscribe: async () => {} }), emit: () => {}, launches: new AutomationLaunches(join(root, "receipts")), launch: async (cwd, prompt) => {
  if (preflightRefuses) throw new AutomationNotStartedError("Synthetic preflight refusal")
  launches.push({ cwd, prompt })
} })
const a = join(root, "A"), b = join(root, "B")
try {
  for (const [index, cwd] of [a, b].entries()) {
    mkdirSync(join(cwd, ".mako"), { recursive: true })
    writeFileSync(join(cwd, ".mako", "automations.json"), JSON.stringify({ automations: [{ id: "shared", name: "Fixture", prompt: index ? "B-only effect" : "A-only effect", trigger: "manual" }] }))
  }
  const apex = await world.apex("codex", "auto")
  await world.settle(100)
  let full = false, changeBeforeAction = false
  const compose = () => {
    const gate = new AgentAskGate(world.live.asks)
    const tool = new AutomationTool({ gate, conversationOf: () => apex.conversation, tier: () => full ? "full" : "auto", invoke: async (channel, args) => {
      if (channel === "mako:automation-context") {
        const context = service.context()
        if (changeBeforeAction) await service.watch(b)
        return z.json().parse(context)
      }
      if (channel === "mako:run-automation") return z.json().parse(await service.fire(z.string().parse(args[0]), "manual", z.string().optional().parse(args[1]), z.string().optional().parse(args[2])))
      return z.json().parse(channel === "mako:automations" ? service.list() : service.setEnabled(z.string().parse(args[0]), z.boolean().parse(args[1]), z.string().optional().parse(args[2])))
    } })
    gate.runs.automation = (id, want, ask) => tool.allowed(id, want, ask)
    return { gate, tool }
  }
  let current = compose()
  await service.watch(a)
  const loadingB = service.watch(b)
  assert.equal(service.context().cwd, undefined, "a loading B runtime cannot claim ownership of A's previous list")
  const whileLoading = await current.tool.act({ kind: "agent", session: "own" }, { action: "run", id: "shared", clientKey: "while-loading" })
  assert.ok("refused" in whileLoading && whileLoading.refused === "unavailable")
  await loadingB
  assert.equal(service.context().cwd, b)
  for (const action of ["run", "on", "off"] as const) {
    await service.watch(a)
    const requested = await current.tool.act({ kind: "agent", session: "own" }, { action, id: "shared", clientKey: action })
    assert.ok("ask" in requested)
    const original = structuredClone(current.gate.open(apex.conversation))
    assert.equal(original[0]?.want.kind === "automation" && original[0].want.cwd, a)
    await service.watch(b)
    const other = await current.tool.act({ kind: "agent", session: "own" }, { action, id: "shared", clientKey: action })
    assert.ok("ask" in other)
    assert.notEqual(other.ask, requested.ask, "the same automation ID in another workspace is a distinct ask")
    await current.gate.answer(apex.conversation, other.ask, false)
    await assert.rejects(current.gate.answer(apex.conversation, requested.ask, true), /workspace changed/)
    assert.deepEqual(current.gate.open(apex.conversation), original)
    assert.equal(service.list()[0]?.enabled, false)
    assert.equal(launches.filter(launch => launch.cwd === b).length, 0)
    await world.close()
    world = new AgentsWorld({ root, script: () => "ok" })
    current = compose()
    assert.deepEqual(current.gate.open(apex.conversation), original, "the original owner survives journal recovery")
    await assert.rejects(current.gate.answer(apex.conversation, requested.ask, true), /workspace changed/)
    await service.watch(a)
    if (action === "run") {
      preflightRefuses = true
      await assert.rejects(current.gate.answer(apex.conversation, requested.ask, true), /Synthetic preflight/)
      await service.watch(b)
      await assert.rejects(current.gate.answer(apex.conversation, requested.ask, true), /workspace changed/)
      assert.deepEqual(current.gate.open(apex.conversation), original, "a known-not-run retry cannot change its owner")
      preflightRefuses = false
      await service.watch(a)
    }
    await Promise.all([current.gate.answer(apex.conversation, requested.ask, true), current.gate.answer(apex.conversation, requested.ask, true)])
    await current.gate.answer(apex.conversation, requested.ask, true)
    assert.deepEqual(current.gate.open(apex.conversation), [])
  }
  assert.deepEqual(launches, [{ cwd: a, prompt: "A-only effect" }])
  const legacy = current.gate.ask(apex.conversation, { kind: "automation", action: "run", id: "shared" })
  await assert.rejects(current.gate.answer(apex.conversation, legacy.id, true), /older ask/)
  assert.deepEqual(current.gate.open(apex.conversation), [legacy], "legacy asks without an owner fail closed and stay answerable")
  await current.gate.answer(apex.conversation, legacy.id, false)
  full = true
  for (const action of ["run", "on", "off"] as const) {
    await service.watch(a)
    changeBeforeAction = true
    const result = await current.tool.act({ kind: "agent", session: "own" }, { action, id: "shared", clientKey: `full-${action}` })
    changeBeforeAction = false
    assert.ok("refused" in result && result.refused === "failed", "the mutation boundary checks ownership again after its list was read")
    assert.equal(service.list()[0]?.enabled, false)
  }
  assert.equal(launches.length, 1)
  console.log("automation workspace: run/on/off bind original owner before approval, reject same-ID B before admission and after known refusal/restart, preserve same-owner concurrent retry, refuse legacy ownerless asks and full-access read/action races")
} finally {
  service.stop()
  git.close()
  await world.close()
  rmSync(root, { recursive: true, force: true })
}

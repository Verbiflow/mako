import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * Which role the engine reads for each Thread, as its `mako` server's agents_* tools are listed (`Agents.toolRole`,
 * `ROLE_HIDES`; `test-tool-budget.ts` holds each role's tool set): a Thread with no Fins, then an Apex once it starts
 * one, a worker Fin, a lead Fin (an Apex of its own from its start), and a worker Fin once it starts a Fin of its own.
 */
const root = mkdtempSync(join(tmpdir(), "mako-tool-roles-"))
const world = new AgentsWorld({ root, script: () => "ok" })
try {
  const apex = await world.apex("claude", "full")
  assert.equal(world.agents.toolRole(apex.conversation), "thread", "a Thread with no Fins")

  const start = async (caller: typeof apex.caller, name: string, role?: "lead") => {
    const answer = await world.agents.start(caller, { brief: { objective: `Check ${name}` }, name, harness: "codex", cwd: root, clientKey: name, ...(role && { role }) })
    assert.ok(!("refused" in answer) && answer.conversation, JSON.stringify(answer))
    return answer.conversation
  }
  const worker = await start(apex.caller, "worker")
  assert.equal(world.agents.toolRole(apex.conversation), "apex", "a Thread that started a Fin")
  assert.equal(world.agents.toolRole(worker), "fin", "a worker Fin")

  const lead = await start(apex.caller, "lead", "lead")
  assert.equal(world.agents.toolRole(lead), "fin-apex", "a lead Fin is an Apex of its own from its start")

  await start(world.caller(worker), "helper")
  assert.equal(world.agents.toolRole(worker), "fin-apex", "a worker Fin that starts a Fin of its own")
  await world.settle(300, 30_000, "ignore")
  console.log("tool roles: thread, apex, fin, fin-apex read as each Thread stands")
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import type { AgentRefused } from "@mako/host/contracts/agents"
import type { AgentsListResult } from "@mako/host/contracts/agent-tools"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * A prompt and a list read no report again while none is new (`npm run test:agents-doors`).
 *
 * Every prompt sent to an Apex and every `agents_list` read every stored report of every Fin: `openPRsOf` and
 * `owesApex` each asked the store for them all (SQL and a parse a row), and every commit made `openReportAsks` do the
 * same. One Apex's Fins held 6,520 reports: 11 MB parsed a call. Now the engine keeps, by Fin, what a row takes from
 * its reports, added to as each report is kept and read again only when its newest isn't the one held; the store keeps
 * which reports ask, by Fin, while its reports are the same rows.
 *
 * Held here: a second list and a second front door with nothing changed read no report (`ThreadStore.reportsOf` is
 * called zero times); nor do they after a commit that touches no report; a new report is seen at once, whoever kept it
 * (this engine, or another host writing the store), and reads no other Fin's reports; an answer is seen at once.
 */
const root = mkdtempSync(join(tmpdir(), "mako-reports-held-"))

function kept<T extends object>(value: T | AgentRefused): T {
  assert.ok(!("refused" in value), JSON.stringify(value))
  return value
}

const world = new AgentsWorld({
  root,
  finLimit: () => 8,
  later: () => () => {},
  script: async (turn) => {
    const fin = /You're fin:(\S+?),/.exec(turn.text)?.[1]
    if (fin === "pulls") {
      await turn.world.agents.report(turn.caller, { status: "done", summary: "Opened the pull request.", artifacts: [{ kind: "pull-request", ref: "https://git.example.com/acme/app/pull/11" }], clientKey: "pr" })
      return "Reported."
    }
    if (fin === "busy") return turn.world.hold(turn.conversation).then(() => "Cut.")
    return fin ? `${fin} finished.` : "ok"
  },
})
try {
  const apex = await world.apex("codex", "full")
  const fins = new Map<string, { conversation: string; child: string }>()
  for (const name of ["pulls", "plain", "busy"]) {
    const started = kept(await world.agents.start(apex.caller, { brief: { objective: `Do ${name}` }, harness: "claude", name, clientKey: name, cwd: root }))
    fins.set(name, { conversation: started.conversation!, child: started.child! })
  }
  while (world.live.session(fins.get("busy")!.conversation)?.status !== "running") await new Promise((resolve) => setTimeout(resolve, 10))
  // A history worth not reading again.
  const pulls = ThreadIdSchema.parse(fins.get("pulls")!.child)
  const generation = world.store.latestReports().get(pulls)!.ownerGeneration
  for (let index = 0; index < 300; index++)
    world.store.keepReport({ id: `report:${pulls}:old-${index}`, child: pulls, status: "progress", summary: `Step ${index}.`, ownerGeneration: generation, at: Date.now() })
  world.store.markReportsDelivered(Array.from({ length: 300 }, (_, index) => `report:${pulls}:old-${index}`), Date.now())
  await new Promise((resolve) => setTimeout(resolve, 2_600))

  const reads = mock.method(world.store, "reportsOf")
  const read = () => reads.mock.calls.map((call) => String(call.arguments[0]))
  const rows = (listed: AgentsListResult) => {
    assert.ok(!("refused" in listed) && "children" in listed, JSON.stringify(listed))
    return new Map(listed.children.map((strip) => [strip.name, strip]))
  }
  const list = async () => rows(await world.agents.list(apex.caller, {}))
  const door = () => world.agents.frontDoor(apex.conversation, {}, true, true).join("\n")

  // The first look reads each Fin's reports once; the second, with nothing changed, reads none.
  const first = await list()
  assert.deepEqual(first.get("pulls")?.openPRs, [{ repository: "acme/app", number: 11, url: "https://git.example.com/acme/app/pull/11", state: "reported" }])
  assert.ok(read().length > 0, "the first list read them")
  reads.mock.resetCalls()
  const second = await list()
  assert.deepEqual(read(), [], "a second list with nothing changed reads no report")
  assert.deepEqual(second.get("pulls")?.openPRs, first.get("pulls")?.openPRs)
  kept(await world.agents.list(apex.caller, { scope: "all" }))
  assert.deepEqual(read(), [], "nor does scope all")
  const note = door()
  reads.mock.resetCalls()
  assert.equal(door(), note, "a second front door says the same")
  assert.deepEqual(read(), [], "and reads no report")
  console.log("a second list and a second front door with nothing changed read no report")

  // A commit that touches no report (a start another device cancelled, kept by its op) costs none either.
  world.store.cancelStart(`start:${randomUUID()}:x`, Date.now())
  await list()
  door()
  assert.deepEqual(read(), [], "a commit of anything else parses no report again")
  console.log("a commit that touches no report: none read")

  // A new report is seen at once, and no other Fin's reports are read for it.
  const busy = ThreadIdSchema.parse(fins.get("busy")!.child)
  kept(await world.agents.report(world.caller(fins.get("busy")!.conversation), { status: "progress", summary: "Opened #12 for the busy work.", artifacts: [{ kind: "pull-request", ref: "https://git.example.com/acme/app/pull/12" }], clientKey: "pr-12" }))
  reads.mock.resetCalls()
  const third = await list()
  assert.deepEqual(third.get("busy")?.openPRs, [{ repository: "acme/app", number: 12, url: "https://git.example.com/acme/app/pull/12", state: "reported" }], "its row has the new report's pull request at once")
  assert.deepEqual(third.get("busy")?.report?.line, "Opened #12 for the busy work.")
  assert.match(door(), /fin:busy[^\n]*Opened #12 for the busy work\./, "and so has the front door")
  assert.ok(read().every((child) => child === busy), `no other Fin's reports were read: ${read().join(" ")}`)
  console.log("a new report: seen at once, no other Fin's reports read")

  // One another host kept, written to the store beside this engine, is seen as soon too.
  world.store.keepReport({ id: `report:${pulls}:elsewhere`, child: pulls, status: "done", summary: "A second pull request.", artifacts: [{ kind: "pull-request", ref: "https://git.example.com/acme/app/pull/13" }], ownerGeneration: generation, at: Date.now() })
  world.store.markReportsDelivered([`report:${pulls}:elsewhere`], Date.now())
  reads.mock.resetCalls()
  const fourth = await list()
  assert.deepEqual(fourth.get("pulls")?.openPRs?.map((pull) => pull.number), [13, 11], "the newest report's first")
  assert.ok(read().every((child) => child === pulls), `only that Fin's reports were read: ${read().join(" ")}`)
  reads.mock.resetCalls()
  await list()
  assert.deepEqual(read(), [], "and once read, not again")
  console.log("a report another host kept: seen at once, read once")

  // A question, and its answer, each at once.
  const plain = ThreadIdSchema.parse(fins.get("plain")!.child)
  const asked = kept(await world.agents.report(world.caller(fins.get("plain")!.conversation), { status: "done", summary: "Two ways to ship.", question: "Ship the small one?", clientKey: "ask" }))
  assert.equal((await list()).get("plain")?.pendingQuestions, 1, "its question is counted at once")
  reads.mock.resetCalls()
  world.store.claimAnswer({ ask: asked.id, child: plain, op: "answer:test", by: "person", answer: "Yes", request: randomUUID(), text: "Yes", at: Date.now() })
  assert.equal((await list()).get("plain")?.pendingQuestions, undefined, "and its answer")
  assert.deepEqual(read().filter((child) => child !== plain), [], "an answer reads no other Fin's reports")
  console.log("a question and its answer: each seen at once")

  world.release(fins.get("busy")!.conversation)
  await world.settle(600)
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
console.log("reports held: ok")

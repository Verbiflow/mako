import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * A Fin's open report questions (`ThreadStore.openReportAsks`) are kept until a write that can change them: a report
 * kept or an answer claimed for that Fin changes its own, and leaves every other Fin's as it was. An Apex's walk of its
 * tree reads every Fin's after each report (`Agents.personAsk`); dropped for all of them on every write, a tree of 139
 * Fins read and parsed every report it ever kept, each time.
 */
const root = mkdtempSync(join(tmpdir(), "mako-report-asks-"))
const world = new AgentsWorld({ root, script: () => "ok", budget: { running: 4, started: 4 } })
try {
  const apex = await world.apex("claude", "full")
  const ids: string[] = []
  for (const name of ["fin-a", "fin-b"]) {
    const started = await world.agents.start(apex.caller, { brief: { objective: name }, name, harness: "claude", cwd: world.root, clientKey: name })
    assert.ok(!("refused" in started), JSON.stringify(started))
    ids.push(started.child!)
  }
  await world.settle(40, 60_000)
  const a = ThreadIdSchema.parse(ids[0])
  const b = ThreadIdSchema.parse(ids[1])
  const store = world.store
  const ask = (child: string, n: number) => store.keepReport({ id: `report:${child}:${n}`, child: ThreadIdSchema.parse(child), status: "needs-input", summary: `Question ${n}`, question: `Which way, ${n}?`, retainsQuestion: true, ownerGeneration: Number.MAX_SAFE_INTEGER, at: Date.now() + n })
  ask(a, 1)
  ask(b, 1)
  const before = store.openReportAsks(a)
  assert.equal(before.length, 1)
  assert.equal(store.openReportAsks(a), before, "kept between reads")

  ask(b, 2)
  assert.equal(store.openReportAsks(a), before, "another Fin's report leaves this one's kept")
  assert.deepEqual(store.openReportAsks(b).map((report) => report.id), [`report:${b}:1`, `report:${b}:2`], "and changes that Fin's own: both its questions open")

  store.markReportsDelivered([`report:${a}:1`], Date.now())
  assert.equal(store.openReportAsks(a), before, "a delivery changes no question")

  store.claimAnswer({ ask: `report:${a}:1`, child: a, op: "answer-a", by: "lead", answer: "Left", request: "answer-a", text: "Left", at: Date.now() })
  assert.deepEqual(store.openReportAsks(a), [], "an answer claimed for it changes its own")
  console.log("report asks kept: a Fin's open questions are read again only after a write that can change them")
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}

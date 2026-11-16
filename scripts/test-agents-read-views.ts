import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * `agents_read`'s outcome view and search (`npm run test:agents-doors`): `view: "outcome"` is a Fin's latest result and
 * how it stands, without the progress it reported after it or a transcript; `search` finds words in its whole history
 * through `thread_history`'s search of its Thread, a page at a time.
 */
const root = mkdtempSync(join(tmpdir(), "mako-agents-read-views-"))
const script: Script = async (turn) => {
  if (turn.text.includes("Fix the cache")) {
    await turn.world.agents.report(turn.caller, { status: "done", summary: "Fixed the cache key: it dropped the tenant.", clientKey: "fixed" })
    return "The tenant id now goes into the cache key, so two tenants never share an entry."
  }
  // Its next piece of work: progress reported, the turn still running.
  if (turn.text.includes("Tidy the docs")) {
    await turn.world.agents.report(turn.caller, { status: "progress", summary: "Now tidying the docs around it.", clientKey: "docs" })
    return turn.world.hold(turn.conversation).then(() => "Docs tidied.")
  }
  if (turn.text.includes("Long work")) return turn.world.hold(turn.conversation).then(() => "Held.")
  return "ok"
}
const world = new AgentsWorld({ root, script })
try {
  const apex = await world.apex("claude", "full")
  const cache = await world.agents.start(apex.caller, { brief: { objective: "Fix the cache key." }, name: "cache", harness: "codex", cwd: world.root, clientKey: "cache" })
  assert.ok(!("refused" in cache), JSON.stringify(cache))
  await world.settle(300, 20_000, "ignore")
  const sent = await world.agents.send(apex.caller, { to: "cache", text: "Tidy the docs around it.", clientKey: "docs" })
  assert.ok(!("refused" in sent), JSON.stringify(sent))
  const tidying = Date.now() + 20_000
  while (!world.store.reportsOf(cache.child!).some((each) => each.summary.includes("tidying"))) {
    assert.ok(Date.now() < tidying, "its progress on the docs")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // One still at work, its turn held: it has no result yet.
  const slow = await world.agents.start(apex.caller, { brief: { objective: "Long work: the migration." }, name: "slow", harness: "codex", cwd: world.root, clientKey: "slow" })
  assert.ok(!("refused" in slow) && slow.conversation, JSON.stringify(slow))
  const deadline = Date.now() + 20_000
  while (world.live.session(slow.conversation!)?.status !== "running") {
    assert.ok(Date.now() < deadline, "the slow Fin's turn to run")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  const report = await world.agents.read(apex.caller, { child: "cache" })
  assert.ok(!("refused" in report) && report.text.includes("tidying the docs"), `the report view is its last report: ${JSON.stringify(report)}`)
  const outcome = await world.agents.read(apex.caller, { child: "cache", view: "outcome" })
  assert.ok(!("refused" in outcome), JSON.stringify(outcome))
  assert.ok(outcome.text.startsWith("done:") && outcome.text.includes("dropped the tenant"), `the outcome view is its result: ${outcome.text}`)
  assert.ok(!outcome.text.includes("tidying the docs"), "without the progress after it")
  const none = await world.agents.read(apex.caller, { child: "slow", view: "outcome" })
  assert.ok(!("refused" in none) && none.text.startsWith("No result yet. It is working"), `a Fin with no result says so: ${JSON.stringify(none)}`)

  const found = await world.agents.read(apex.caller, { child: "cache", search: "tenant id" })
  assert.ok(!("refused" in found), JSON.stringify(found))
  assert.match(found.text, /^1 hit for "tenant id"/, found.text)
  assert.ok(found.text.includes("cache key"), "the hit's line shows the words around it")
  const missed = await world.agents.read(apex.caller, { child: "cache", search: "zebra" })
  assert.ok(!("refused" in missed) && missed.text.startsWith('No match for "zebra"'), JSON.stringify(missed))
  const mixed = await world.agents.read(apex.caller, { child: "cache", search: "tenant", view: "transcript" })
  assert.ok("refused" in mixed && mixed.refused === "conflict", "search reads only the history: no view beside it")
  const empty = await world.agents.read(apex.caller, { child: "cache", search: "  " })
  assert.ok("refused" in empty && empty.refused === "conflict", "and needs words")
  console.log("agents_read: outcome is the latest result without later progress; search finds words in a Fin's whole history")
  world.release(slow.conversation!)
  world.release(cache.conversation!)
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}

import assert from "node:assert/strict"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { RESET_MARGIN_MS } from "@mako/host/contracts/delivery-retry"
import { strandedTurn } from "@mako/host/contracts/turn-continuation"
import { AgentsWorld, type WorldAccount } from "./agents-world.ts"

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 8_000
  while (!check()) { assert.ok(performance.now() < deadline, label); await delay(5) }
}

/** Native limit markers, rather than parsed provider prose, own this logical turn's reset wait. */
export async function usageResetControls(root: string): Promise<void> {
  for (const ending of ["failed", "ready"] as const) {
    for (const [outcome, moving] of [
      ["recover", "off"], ["restart", "off"], ["crash", "off"], ["stop", "off"], ["close", "off"],
      ["recover", "exhausted"], ["restart", "exhausted"],
      ["recover", "none"],
    ] as const) {
      const reset = Date.now() + 3_600_000
      let held = false
      const accounts: WorldAccount[] = [{ name: "default" }, ...moving === "none" ? [] : [{ name: "other", spentUntil: reset }]]
      const world = new AgentsWorld({ root: join(root, `reset-${moving}-${ending}-${outcome}`), moveOnLimit: () => moving !== "off",
        accounts: { claude: accounts },
        ...(moving !== "off" && { catalogs: { claude: [{ id: "fixture-model", label: "Fixture model", options: [] }] }, order: ["claude"] }),
        script: async turn => {
          if (!held && turn.text.includes("Limit input")) { held = true; await turn.world.hold(turn.conversation) }
          return "Fixture work completed."
        } })
      try {
        const apex = await world.apex("codex")
        const start = await world.agents.start(apex.caller, { brief: { objective: "Fixture work" }, harness: "claude", name: "worker", cwd: world.root, clientKey: "start" })
        assert.ok(!("refused" in start) && start.conversation && start.child)
        const id = start.conversation!
        await until(() => world.live.snapshot(id)?.requests.at(-1)?.status === "completed", "brief completes")
        const cut = await world.agents.send(apex.caller, { to: "worker", text: "Limit input", clientKey: "cut" })
        assert.ok(!("refused" in cut))
        await until(() => world.live.session(id)?.status === "running", "turn runs")
        const before = await world.agents.send(apex.caller, { to: "worker", text: "Queued before limit", clientKey: "before" })
        assert.ok(!("refused" in before))
        if (moving !== "off") accounts[0]!.spentUntil = reset
        world.endWith(id, { limit: { window: "usage limit", resetsAt: reset }, ...(ending === "failed" && { fail: "Reached your usage limit" }) })
        world.release(id)
        const snapshot = () => world.live.snapshot(id)!
        await until(() => snapshot().requests.find(request => request.id === cut.request)?.status === "failed", "limit is not completion")
        const continuation = snapshot().requests.find(request => request.continues?.requestId === cut.request)!
        assert.equal(continuation.status, "held")
        assert.equal(continuation.retry?.until, reset)
        assert.equal(continuation.retry.at, reset + RESET_MARGIN_MS)
        if (moving !== "off") {
          await until(() => world.store.finTurn(start.child!)?.handled.includes(continuation.id) === true, "the exhausted fallback decision settled")
          assert.equal(world.store.edges().of(start.child!)?.closedAt, undefined, "exhausted fallback retains the reset wait, not a Stop")
        }
        world.live.observe({ type: "live-session", session: { ...snapshot().session, status: "ready" } })
        assert.equal(snapshot().requests.filter(request => request.continues?.requestId === cut.request).length, 1, "a duplicate terminal event cannot duplicate the continuation")
        const later = await world.agents.send(apex.caller, { to: "worker", text: "Queued during limit", clientKey: "later" })
        assert.ok(!("refused" in later))
        assert.equal(snapshot().requests.find(request => request.id === continuation.id)?.status, "held", "new messages cannot release the usage-limit wait")
        assert.equal(strandedTurn(snapshot().requests), undefined)
        await delay(20)
        assert.equal(world.store.reportsOf(start.child, 0).some(report => report.id === `report:${start.child}:${cut.request}`), false, "held work is not an implicit terminal report")
        assert.equal(world.store.reportsOf(start.child, 0).some(report => report.question), false, "no Continue/Stop question")
        const reading = world.agents.roster(apex.conversation).find(entry => entry.child?.thread === start.child)?.child?.state
        assert.equal(reading?.kind, "working", "the logical Fin is waiting, not finished or failed")
        assert.ok(reading?.kind === "working" && reading.step?.includes("usage limit"))
        assert.equal(world.live.atWork(id), false, "a long quota wait holds no execution place")
        if (outcome === "restart" || outcome === "crash") {
          await (outcome === "restart" ? world.restart() : world.crashed())
          assert.equal(snapshot().requests.find(request => request.id === continuation.id)?.status, "held")
          assert.equal(snapshot().requests.find(request => request.id === continuation.id)?.retry?.until, reset, "same reset after host recovery")
        }
        const count = () => world.prompts.filter(prompt => prompt.conversation === id).length
        if (outcome === "stop" || outcome === "close") {
          await (outcome === "stop" ? world.live.cancel(id) : world.live.close(id))
          const stopped = count()
          world.live.wakeDue(reset + RESET_MARGIN_MS + 1)
          await world.settle(20, 8_000, "ignore")
          assert.equal(count(), stopped, "Stop/Close defeats reset recovery")
          continue
        }
        const waiting = count()
        world.live.wakeDue(reset - 1)
        await delay(20)
        assert.equal(count(), waiting, "nothing dispatches before reset")
        delete accounts[0]!.spentUntil
        world.live.wakeDue(reset + RESET_MARGIN_MS + 1)
        await until(() => [continuation.id, before.request, later.request].every(id => snapshot().requests.some(request => request.id === id && request.status === "completed")), "continuation and both queued IDs finish")
        for (const text of ["Queued before limit", "Queued during limit"])
          assert.equal(world.prompts.filter(prompt => prompt.conversation === id && prompt.text.includes(text)).length, 1)
        assert.equal(snapshot().session.harness, "claude")
      } finally { await world.close() }
    }
  }
  await usageGoalResetControls(root)
  console.log("PASS: with moves off or no eligible fallback, failed/ready native limits hold until reset, preserve queued IDs through restart/crash, ask no question and yield to Stop/Close")
}

export async function usageGoalResetControls(root: string): Promise<void> {
  for (const ending of ["failed", "ready"] as const) {
    let held = false
    const reset = Date.now() + 3_600_000
    const world = new AgentsWorld({ root: join(root, `goal-reset-${ending}`), moveOnLimit: () => false,
      script: async turn => {
        if (!held && turn.text.includes("Limited goal")) { held = true; await turn.world.hold(turn.conversation); return "Goal: working" }
        return "Goal: complete — fixture work finished"
      } })
    try {
      const apex = await world.apex("claude")
      await world.live.goal(apex.conversation, { kind: "set", objective: "Limited goal" })
      await until(() => world.live.session(apex.conversation)?.status === "running", "goal turn runs")
      const original = world.live.snapshot(apex.conversation)!.requests.find(request => request.status === "dispatching")!
      world.endWith(apex.conversation, { limit: { resetsAt: reset }, ...(ending === "failed" && { fail: "Reached your usage limit" }) })
      world.release(apex.conversation)
      await until(() => world.live.snapshot(apex.conversation)!.requests.some(request => request.continues?.requestId === original.id), "goal owns a reset continuation")
      assert.equal(world.live.snapshot(apex.conversation)!.goal?.status, "active", "a temporary limit does not block the objective")
      world.live.wakeDue(reset + RESET_MARGIN_MS + 1)
      await until(() => world.live.snapshot(apex.conversation)!.goal?.status === "complete", "the resumed goal can finish without Resume")
    } finally { await world.close() }
  }
}

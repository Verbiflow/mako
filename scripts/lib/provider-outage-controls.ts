import assert from "node:assert/strict"
import { join } from "node:path"
import { strandedTurn } from "@mako/host/contracts/turn-continuation"
import { signInPause } from "@mako/host/contracts/sign-in-hold"
import { AgentsWorld } from "./agents-world.ts"

const OUTAGES = [
  "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
  "Failed to authenticate. API Error: 503 Service Unavailable",
  "Failed to authenticate. API Error: 529 Overloaded",
]

async function until(what: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000
  while (!check()) {
    assert.ok(Date.now() < deadline, what)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Real local store/dispatch/Fin path, with scripted transports and no account or provider calls. */
export async function providerOutageControls(root: string): Promise<void> {
  for (const [index, error] of OUTAGES.entries()) {
    for (const outcome of ["recover", "restart", "crash", "stop", "close"] as const) {
      let heldOnce = false
      const world = new AgentsWorld({
        root: join(root, `outage-${index}-${outcome}`),
        // An available fixture account, unchanged throughout the outage.
        accounts: { claude: [{ name: "default" }] },
        moveOnLimit: () => false,
        script: async turn => {
          if (!heldOnce && turn.text.includes("Outage input")) {
            heldOnce = true
            await turn.world.hold(turn.conversation)
          }
          return "Done."
        },
      })
      try {
        const apex = await world.apex("codex")
        const started = await world.agents.start(apex.caller, { brief: { objective: "Fixture work" }, harness: "claude", name: "worker", cwd: world.root, clientKey: "start" })
        assert.ok(!("refused" in started) && started.conversation)
        const id = started.conversation!
        await until("brief completed", () => world.live.snapshot(id)?.requests.at(-1)?.status === "completed")
        const cut = await world.agents.send(apex.caller, { to: "worker", text: "Outage input", clientKey: "cut" })
        assert.ok(!("refused" in cut))
        await until("turn running", () => world.live.session(id)?.status === "running")
        const before = await world.agents.send(apex.caller, { to: "worker", text: "Queued before outage", clientKey: "before" })
        assert.ok(!("refused" in before))
        world.endWith(id, { fail: error })
        world.release(id)
        await until("outage settled", () => world.live.snapshot(id)?.requests.find(request => request.id === cut.request)?.status !== "dispatching")
        const snapshot = () => world.live.snapshot(id)!
        assert.equal(signInPause(snapshot().requests), undefined, "an edge/service failure is not a sign-out")
        const failed = snapshot().requests.find(request => request.id === cut.request)!
        assert.equal(failed.failure, "provider-unavailable")
        assert.equal(strandedTurn(snapshot().requests), undefined, "no Continue/Stop fallback while the retry owns recovery")
        assert.equal(failed.retry?.attempt, 1, "known-run turn gets a timed continuation")
        assert.ok(failed.retry.at > Date.now())
        let continuation = snapshot().requests.find(request => request.continues?.requestId === cut.request)!
        assert.equal(continuation.status, "held")
        const at = continuation.retry!.at
        const later = await world.agents.send(apex.caller, { to: "worker", text: "Queued during outage", clientKey: "later" })
        assert.ok(!("refused" in later))
        assert.equal(later.delivery, "queued", "saved is not native acceptance while the retry waits")
        assert.equal(snapshot().requests.find(request => request.id === continuation.id)?.status, "held", "a new message cannot bypass an outage backoff")
        assert.equal(snapshot().requests.find(request => request.id === continuation.id)?.retry?.at, at)
        assert.equal(world.prompts.filter(prompt => /Queued (before|during) outage/.test(prompt.text)).length, 0)
        if (outcome === "restart" || outcome === "crash") {
          await (outcome === "restart" ? world.restart() : world.crashed())
          assert.equal(snapshot().requests.find(request => request.id === continuation.id)?.retry?.at, at, "same durable retry after restart")
          assert.equal(signInPause(snapshot().requests), undefined)
        }
        if (outcome === "stop" || outcome === "close") {
          await (outcome === "stop" ? world.live.cancel(id) : world.live.close(id))
          const count = world.prompts.filter(prompt => prompt.conversation === id).length
          world.live.wakeDue(at + 1)
          await world.settle(30, 8_000, "ignore")
          assert.equal(world.prompts.filter(prompt => prompt.conversation === id).length, count, "Stop/Close defeats a delayed retry of this Fin")
          assert.notEqual(snapshot().requests.find(request => request.id === later.request)?.status, "completed")
          continue
        }
        if (outcome === "recover") world.endWith(id, { fail: error })
        world.live.wakeDue(at + 1)
        if (outcome === "recover") {
          const previous = continuation
          await until("second outage grows the backoff", () => snapshot().requests.some(request => request.continues?.requestId === previous.id && request.status === "held"))
          continuation = snapshot().requests.find(request => request.continues?.requestId === previous.id)!
          assert.equal(continuation.retry?.attempt, 2)
          assert.equal(continuation.retry?.since, failed.retry.since, "failure does not reset the retry budget")
          assert.ok(continuation.retry!.at > at)
          world.live.wakeDue(continuation.retry!.at + 1)
        }
        await until(`${outcome}: continuation and both original message IDs completed`, () => [continuation.id, before.request, later.request].every(requestId => snapshot().requests.some(request => request.id === requestId && request.status === "completed")))
        assert.equal(snapshot().session.harness, "claude", "recovered in place, without a move")
        for (const text of ["Queued before outage", "Queued during outage"])
          assert.equal(world.prompts.filter(prompt => prompt.conversation === id && prompt.text.includes(text)).length, 1, `${text}: native admission once`)
        assert.equal(snapshot().requests.some(request => request.signIn !== undefined), false)
      } finally {
        await world.close()
      }
    }
  }
  console.log("provider outage controls: false-auth edge/service failure, pending messages, growing backoff, restart/crash, Stop and Close passed")
}

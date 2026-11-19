import assert from "node:assert/strict"
import { join } from "node:path"
import { AgentsWorld, TESTED_HARNESSES } from "./agents-world.ts"
import { CONNECTION_LOST_STOP } from "@mako/host/contracts/providers-acp"
import { GIVE_UP_MS } from "@mako/host/contracts/delivery-retry"
import { strandedTurn } from "@mako/host/contracts/turn-continuation"
import { followHostLog, type HostLogLine } from "@mako/host/base/host-log"

async function until(what: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000
  while (!check()) {
    assert.ok(Date.now() < deadline, what)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Actual request/store/timer paths with scripted transports; no account, model or installed-host calls. */
export async function transientInterruptionControls(root: string): Promise<void> {
  for (const harness of TESTED_HARNESSES) {
    for (const outcome of ["recover", "restart", "stop", "exhausted"] as const) {
      let turns = 0
      const world = new AgentsWorld({ root: join(root, `network-${harness}-${outcome}`),
        script: async turn => {
          if (!turn.text.includes("After outage")) { turns++; await turn.world.hold(turn.conversation) }
          return "Done."
        } })
      try {
        const { conversation: id } = await world.apex(harness, "full")
        const source = world.say(id, "Original work")
        const snapshot = () => world.live.snapshot(id)!
        await until("original turn running", () => snapshot().session.status === "running")
        world.endWith(id, { fail: "fetch failed: connection reset", lastStop: CONNECTION_LOST_STOP }); world.release(id)
        await until("network interruption settled", () => snapshot().requests.find(r => r.id === source)?.status === "interrupted")
        const interrupted = snapshot().requests.find(r => r.id === source)!
        assert.equal(interrupted.retry?.cause, "network", "a dropped accepted turn must enter bounded backoff, not one-shot auto-continue")
        const first = snapshot().requests.find(r => r.continues?.requestId === source)!
        assert.equal(first.status, "held")
        assert.equal(first.retry?.attempt, 1)
        assert.equal(strandedTurn(snapshot().requests), undefined)
        // Queue draining after a host exit is a separate cut-turn policy; this restart control measures the retry itself.
        let queued = outcome === "restart" ? undefined : world.say(id, "After outage")
        assert.equal(snapshot().requests.find(r => r.id === first.id)?.status, "held", "later input cannot bypass outage recovery")
        const count = world.prompts.length
        world.live.wakeDue(first.retry!.at - 1)
        assert.equal(world.prompts.length, count, "no early retry")
        if (outcome === "stop") {
          await world.live.cancel(id)
          world.live.wakeDue(first.retry!.at + 1)
          await world.settle(30, 8_000, "ignore")
          assert.equal(world.prompts.length, count, "Stop defeats delayed recovery")
          continue
        }
        if (outcome === "restart") {
          await world.restart()
          assert.equal(snapshot().requests.find(r => r.id === first.id)?.retry?.at, first.retry!.at)
          queued = world.say(id, "After outage")
        }
        world.live.wakeDue(first.retry!.at + 1)
        await until("continuation running", () => turns === 2 && snapshot().session.status === "running")
        if (outcome === "exhausted") {
          const now = Date.now()
          // Age the persisted retry, as an outage still present at its final attempt.
          const record = snapshot().requests.find(r => r.id === first.id)!
          record.retry!.since = now - GIVE_UP_MS.network
        }
        world.endWith(id, { fail: "fetch failed: connection reset", lastStop: CONNECTION_LOST_STOP }); world.release(id)
        await until("continuation settled", () => snapshot().requests.find(r => r.id === first.id)?.status !== "dispatching")
        const second = snapshot().requests.find(r => r.continues?.requestId === first.id)
        if (outcome === "exhausted") {
          assert.equal(snapshot().requests.find(r => r.id === first.id)?.status, "failed")
          assert.equal(second, undefined, "no new continuation past the original budget")
          assert.equal(snapshot().requests.find(r => r.id === first.id)?.retry, undefined, "exhaustion removes the automatic-retry promise")
          continue
        }
        assert.ok(second, "a second drop cannot strand accepted work")
        assert.equal(second.status, "held")
        assert.equal(second.retry?.attempt, 2)
        assert.equal(second.retry?.since, first.retry!.since)
        assert.ok(second.retry!.at > first.retry!.at)
        assert.equal(strandedTurn(snapshot().requests), undefined)
        world.live.wakeDue(second.retry!.at + 1)
        await until("second continuation running", () => turns === 3 && snapshot().session.status === "running")
        world.release(id)
        await until("continuation and queued input finished", () => [second.id, queued].every(request => snapshot().requests.find(r => r.id === request)?.status === "completed"))
        assert.equal(world.prompts.filter(p => p.text.includes("Original work")).length, 1, "never replay accepted original work")
        assert.equal(world.prompts.filter(p => p.text.includes("After outage")).length, 1)
      } catch (error) {
        console.error("transient control state", JSON.stringify({ harness, outcome, turns, session: world.live.snapshot(world.prompts[0]?.conversation ?? "")?.session.status, requests: world.live.snapshot(world.prompts[0]?.conversation ?? "")?.requests.map(r => ({ id: r.id, status: r.status, retry: r.retry, continues: r.continues, interruption: r.interruption, text: r.text.slice(-120) })) }))
        throw error
      } finally { await world.close() }
    }
  }
  console.log("transient interruption: six harnesses retain bounded backoff through two drops, queued input, restart, Stop and budget exhaustion")
}

export async function heldWakeLogControls(root: string): Promise<void> {
  const lines: HostLogLine[] = []
  const unfollow = followHostLog(line => { if (line.message === "a held message's time came") lines.push(line) })
  let refuse = true
  const world = new AgentsWorld({ root: join(root, "wake-log"),
    script: async turn => turn.text.includes("fin:held") ? turn.world.hold(turn.conversation).then(() => "Done.") : "Done.",
    refusePrompt: (_id, _harness) => {
      if (!refuse) return undefined
      refuse = false
      return "503 Service Unavailable"
    } })
  try {
    const apex = await world.apex("codex", "full")
    const input = world.say(apex.conversation, "ordinary input")
    await until("unsent input held", () => world.live.snapshot(apex.conversation)?.requests.find(r => r.id === input)?.status === "held")
    const retry = world.live.snapshot(apex.conversation)!.requests.find(r => r.id === input)!.retry!
    world.live.wakeDue(retry.at + 1)
    await until("unsent request completed", () => world.live.snapshot(apex.conversation)?.requests.find(r => r.id === input)?.status === "completed")
    assert.ok(lines.some(l => l.fields?.request === input && l.fields.hold === "provider-retry" && l.fields.cause === "provider-unavailable" && l.fields.attempt === 1))
    const started = await world.agents.start(apex.caller, { brief: { objective: "fin:held" }, harness: "codex", name: "held", cwd: world.root, clientKey: "held" })
    assert.ok(!("refused" in started) && started.conversation)
    await until("fin running", () => world.live.session(started.conversation!)?.status === "running")
    world.release(started.conversation!)
    await until("digest coalescing hold", () => world.live.snapshot(apex.conversation)?.requests.some(r => r.wake?.after === "digest") === true)
    const digest = world.live.snapshot(apex.conversation)!.requests.find(r => r.wake?.after === "digest")!
    world.live.wakeDue(digest.wake!.at + 1)
    await until("digest completed", () => world.live.snapshot(apex.conversation)?.requests.find(r => r.id === digest.id)?.status === "completed")
    assert.ok(lines.some(l => l.fields?.request === digest.id && l.fields.hold === "digest" && l.fields.attempt === undefined))
    assert.equal(lines.filter(l => l.fields?.request === input).length, 1)
    assert.equal(lines.filter(l => l.fields?.request === digest.id).length, 1)
  } finally { unfollow(); await world.close() }
  console.log("held wake logs: exact request identity distinguishes provider retry from successful digest coalescing")
}

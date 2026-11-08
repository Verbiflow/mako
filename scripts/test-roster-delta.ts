import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { join } from "node:path"
import { COMPACT_LIVE_FORM, ROSTER_LIVE_FORM, WHOLE_LIVE_FORM, saidLiveForm, saidWindowForm } from "@mako/protocol/live-form"
import { applyRosterPatch, compactLiveBatch, expandLiveBatch, rosteredLiveBatch, type CompactLiveBatch, type LiveBatch } from "@mako/host/contracts/live-conversations"
import { NativeAgentSchema, type NativeAgent, type NativeAgentRoster, type NativeAgentObservation } from "@mako/host/contracts/native-agents"
import { decodeRuntimeEvent, encodeRuntimeEvent, payloadFor, readEventLine } from "@mako/host/contracts/runtime-value"
import { LIVE_FORM_HEADER } from "@mako/host/contracts/runtime"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { startWebHost } from "@mako/host/transport/server"
import { AgentsWorld } from "./lib/agents-world.ts"
import { rosterWindow } from "./lib/roster-window.ts"

/** What a roster's change says, what form each reader hears it in, and what it won't risk. */
function contract(): void {
  const agent = (nativeId: string, observedAt = 1, state = "working"): NativeAgent => NativeAgentSchema.parse({ bindingId: "b", provider: "claude", nativeId, work: "agent", title: `the ${nativeId} agent, with a title long enough to be worth leaving out`, observedAt, state: { kind: state } })
  const roster = (...agents: NativeAgent[]): NativeAgentRoster => ({ agents, limited: false })
  const whole = (nativeAgents: NativeAgentRoster): LiveBatch => ({ id: "c", revision: 2, updates: [], nativeAgents })
  const batch = (nativeAgents: NativeAgentRoster): CompactLiveBatch => compactLiveBatch(whole(nativeAgents), { blocks: [], requests: [] })
  const patchOf = (held: NativeAgentRoster, next: NativeAgentRoster) => rosteredLiveBatch(batch(next), held)?.rosterPatch
  const held = roster(agent("a"), agent("b"), agent("c"), agent("d"))
  const read = (next: NativeAgentRoster) => { const patch = patchOf(held, next); assert.ok(patch, "goes as what changed"); return applyRosterPatch(held, patch) }

  const moved = roster(agent("a"), agent("b", 2), agent("c"), agent("d"))
  assert.deepEqual(read(moved), moved, "an entry that moved")
  assert.deepEqual(patchOf(held, moved)!.agents, [agent("b", 2)], "and only it")
  const added = roster(...held.agents, agent("e"))
  assert.deepEqual(read(added), added, "an entry that's new lands last")
  const gone = roster(agent("a"), agent("c"), agent("d"))
  assert.deepEqual(read(gone), gone, "an entry that's gone")
  const limited = { ...held, limited: true }
  assert.deepEqual(read(limited), limited, "a roster that reached its limit")
  const rewritten = roster(agent("a"), agent("b", 1, "canceled"), agent("c"), agent("d"))
  assert.deepEqual(read(rewritten), rewritten, "an entry rewritten without being observed")
  assert.equal(patchOf(held, roster(agent("b"), agent("a"), agent("c"), agent("d"))), undefined, "order moved: only whole says that")
  assert.equal(patchOf(held, roster(agent("e"), ...held.agents)), undefined, "a new entry anywhere but last: likewise")
  assert.equal(patchOf(roster(agent("a")), roster(agent("b", 2))), undefined, "more to say than the whole: whole")
  assert.equal(rosteredLiveBatch(batch(held), undefined), undefined, "nothing held to write against: whole")

  const patch = patchOf(held, moved)!
  assert.equal(applyRosterPatch(roster(agent("a"), agent("b"), agent("c")), patch), undefined, "a reader holding another roster reads nothing")
  assert.equal(applyRosterPatch(roster(agent("b"), agent("a"), agent("c"), agent("d")), patch), undefined, "nor one in another order")
  assert.equal(applyRosterPatch(roster(agent("a", 9), agent("b"), agent("c"), agent("d")), patch), undefined, "nor one with an entry at another moment")
  assert.equal(applyRosterPatch(roster(agent("a", 1, "canceled"), agent("b"), agent("c"), agent("d")), patch), undefined, "nor one with an entry standing otherwise")
  const expanded = expandLiveBatch({ ...rosteredLiveBatch(batch(moved), held)! }, { blocks: [] })
  assert.ok(expanded.unread, "a reader with no roster to read it against says so")
  assert.deepEqual(expanded.unreadRoster, patch)
  assert.equal(expanded.batch.nativeAgents, undefined, "and doesn't take a roster it can't read")

  // Only a host's own windows hear this form: a reader of any other gets the roster whole, or goes on showing the old one.
  const compact = batch(moved)
  const event = encodeRuntimeEvent({ type: "live-batch", batch: whole(moved), compact, rostered: rosteredLiveBatch(compact, held)! })
  assert.ok(payloadFor(event, WHOLE_LIVE_FORM)?.includes('"nativeAgents"'), "form 1 hears it whole")
  assert.ok(payloadFor(event, COMPACT_LIVE_FORM)?.includes('"nativeAgents"'), "form 2 hears it whole")
  assert.ok(payloadFor(event, ROSTER_LIVE_FORM)?.includes('"rosterPatch"'), "a window hears what changed")
  assert.ok(!payloadFor(event, ROSTER_LIVE_FORM)?.includes('"nativeAgents"'), "and not the roster too")
  assert.ok(payloadFor(event, ROSTER_LIVE_FORM)!.length < payloadFor(event, COMPACT_LIVE_FORM)!.length)
  assert.equal(saidLiveForm("3"), COMPACT_LIVE_FORM, "the gateway's link has no such form")
  assert.equal(saidWindowForm("3"), ROSTER_LIVE_FORM)
  assert.equal(saidWindowForm("2"), COMPACT_LIVE_FORM, "a window of an older build")
  assert.equal(saidWindowForm(undefined), WHOLE_LIVE_FORM)
}

/** Real conversations and socket transport in a scratch root; only scripted drivers, no native harness or live host. */
async function traffic(): Promise<void> {
  const root = mkdtempSync("/tmp/mako-roster-wire-")
  const socket = join(root, "host.sock")
  const server = await startWebHost(socket, async () => undefined, async () => new Response("fixture"))
  const world = new AgentsWorld({ root: join(root, "world"), events: (event) => server.event(event), script: () => "ok" })
  const windows = [rosterWindow(), rosterWindow()]
  const wait = async (what: string, done: () => boolean) => {
    const deadline = Date.now() + 10_000
    while (!done()) {
      assert.ok(Date.now() < deadline, what)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const stream = (form: number) => {
    const events: HostEvent[] = []
    let bytes = 0, ready = false, rest = ""
    const errors: string[] = []
    const call = request({ socketPath: socket, path: "/events", method: "POST", headers: { "x-mako-window": randomUUID(), [LIVE_FORM_HEADER]: String(form) } }, (response) => {
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        rest += chunk.toString("utf8")
        for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
          const line = rest.slice(0, at)
          rest = rest.slice(at + 1)
          const packet = readEventLine(line)
          if (packet) events.push(decodeRuntimeEvent<HostEvent>(packet.payload))
          else if (line.includes('"ready"')) ready = true
        }
      })
      response.on("error", (error) => errors.push(error.message))
    })
    call.on("error", (error) => errors.push(error.message))
    call.end()
    return { events, errors, ready: () => ready, bytes: () => bytes, reset: () => { bytes = 0 }, close: () => call.destroy() }
  }
  const streams = [stream(COMPACT_LIVE_FORM), stream(ROSTER_LIVE_FORM)]
  try {
    await wait("both window streams opened", () => streams.every((stream) => stream.ready()))
    for (const window of windows) await window.ask({ kind: "inspect" })
    const apex = await world.apex("codex")
    const entries: NativeAgentObservation[] = Array.from({ length: 81 }, (_, at) => ({ nativeId: `worker-${at}`, title: `Worker ${at}`, work: "agent", background: true, detail: "The worker's scoped instructions and context. ".repeat(50), state: { kind: "working", activity: "Starting work" } }))
    for (const agent of entries) world.live.observe({ type: "live-agent", id: apex.conversation, agent })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const snapshot = world.live.snapshot(apex.conversation)
    assert.equal(snapshot?.nativeAgents?.agents.length, 81)
    assert.ok(snapshot)
    await wait("seed roster reached both streams", () => streams.every((stream) => stream.events.some((event) => event.type === "live-batch" && event.batch.revision === snapshot.revision)))
    for (const window of windows) await window.ask({ kind: "init", snapshot, listed: true })
    for (const stream of streams) stream.reset()
    let batches = 0
    const consumed = [0, 0]
    const started = performance.now()
    for (let at = 0; at < 40; at += 1) {
      const index = at % entries.length
      entries[index] = { ...entries[index]!, state: { kind: "working", activity: `Step ${at}: checking the next file` } }
      world.live.observe({ type: "live-agent", id: apex.conversation, agent: entries[index]! })
      const current = world.live.snapshot(apex.conversation)
      assert.ok(current)
      await wait("the changed roster reached both windows", () => streams.every((stream) => stream.events.some((event) => event.type === "live-batch" && event.batch.revision === current.revision)))
      const states = []
      for (const [index, window] of windows.entries()) {
        let state = await window.ask({ kind: "inspect" })
        const events = streams[index]!.events
        for (; consumed[index]! < events.length; consumed[index]! += 1) {
          const event = events[consumed[index]!]!
          if (event.type === "live-batch" && event.batch.id === apex.conversation && event.batch.revision > snapshot.revision) {
            state = await window.ask({ kind: "batch", batch: event.batch })
          }
        }
        assert.equal(state.reads.length, 0, `an intact stream needs no recovery: window ${index}, step ${at}, held ${state.held?.revision}, host ${current.revision}, events ${streams[index]!.events.filter((event) => event.type === "live-batch").map((event) => event.batch.revision).join(",")}`)
        assert.deepEqual(state.held?.roster, JSON.parse(JSON.stringify(current.nativeAgents)), "both actual renderer processes hold exactly what the host holds")
        states.push(state)
      }
      assert.equal(states[0]!.drawn, states[1]!.drawn, "presence, children, Inbox and notifications agree at every batch")
      batches += 1
    }
    assert.deepEqual(streams.flatMap((stream) => stream.errors), [])
    const before = streams[0]!.bytes(), after = streams[1]!.bytes()
    assert.ok(after < before / 10, "a one-entry change must not send 81 entries")
    const result = { source: "scratch conversations and actual window socket streams", entries: entries.length, batches, beforeBytes: before, afterBytes: after, reductionPercent: Number((100 * (1 - after / before)).toFixed(2)), elapsedMs: Math.round(performance.now() - started) }
    console.log(`Roster window traffic: ${JSON.stringify(result)}`)
    const out = process.argv.indexOf("--out")
    if (out >= 0) writeFileSync(process.argv[out + 1]!, JSON.stringify(result, null, 2) + "\n")
  } finally {
    for (const stream of streams) stream.close()
    for (const window of windows) window.close()
    await world.close()
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
}

contract()
await traffic()
console.log("Roster delta: contract, real host writer, socket negotiation and both renderer forms agree")

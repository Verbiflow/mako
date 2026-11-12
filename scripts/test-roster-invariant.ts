import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { isDeepStrictEqual } from "node:util"
import { NativeAgentSchema, type NativeAgent, type NativeAgentRoster } from "@mako/host/contracts/native-agents"
import { compactLiveBatch, rosteredLiveBatch, type HeardLiveBatch, type LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { rosterWindow, type WindowCommand, type WindowState } from "./lib/roster-window.ts"

/** Two real renderer processes hear different losses and reads of the same host's generated history. */
const windows = [rosterWindow(), rosterWindow()]
const only = process.env.SEED
const seeds = only ? [Number(only)] : Array.from({ length: Number(process.env.SEEDS ?? 300) }, (_, at) => at + 1)
const totals: Record<string, number> = {}
const count = (name: string) => { totals[name] = (totals[name] ?? 0) + 1 }
const NONE: NativeAgentRoster = { agents: [], limited: false }
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
const agent = (id: string, at: number): NativeAgent => NativeAgentSchema.parse({
  bindingId: "binding", provider: "codex", nativeId: id, title: `Worker ${id}, with a title long enough to be worth leaving out of a change`, observedAt: at,
  state: { kind: "working", activity: `step ${at}` }, child: { thread: `11111111-1111-4111-8111-${id.replace(/\D/g, "").padStart(12, "0").slice(-12)}`, origin: "started", name: id, state: { kind: "working", step: `step ${at}` } },
})

async function run(seed: number): Promise<void> {
  const pick = random(seed)
  const id = `roster-${seed}`
  let revision = 1, generation = 1, clock = 1
  const epoch = () => `g${generation}.roottest.${generation}`
  let roster: NativeAgentRoster | undefined = pick() < 0.3 ? undefined : { agents: ["1", "2", "3", "4"].map((id) => agent(id, clock)), limited: false }
  const history: LiveSnapshot[] = []
  const snapshot = (): LiveSnapshot => ({
    session: { id, harness: "codex", cwd: "/fixture", title: "An Apex", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
    threadId: `22222222-2222-4222-8222-${String(seed).padStart(12, "0")}`, createdAt: 1, epoch: epoch(), revision, base: null, blocks: [], requests: [], permissions: [], ...(roster && { nativeAgents: roster }),
  })
  // A listed Session can retain its journal's older roster at the current revision: the host adds its current Fins
  // in memory. Keep that earlier, real roster in the oracle, and make the first window prove it detects the wrong base.
  const prior = roster && { ...roster, agents: roster.agents.map((each, at) => at === 0 ? { ...each, title: "Before the rename" } : each) }
  if (prior) history.push({ ...snapshot(), revision: 0, nativeAgents: prior })
  history.push(snapshot())
  const sent: HeardLiveBatch[] = []
  const state: WindowState[] = []
  const seen = [0, 0], next = [0, 0], absent = [false, false]
  const reads = windows.map(() => new Map<number, number>())
  const trail: string[] = []
  const check = (window: number) => {
    const held = state[window]!.held
    const where = `seed ${seed}, window ${window}: ${trail.slice(-16).join("; ")}`
    if (absent[window]) assert.equal(held, undefined, `${where}: a late reply resurrected an unlisted conversation`)
    if (!held?.roster) return
    let at = seen[window]!
    while (at < history.length && !isDeepStrictEqual(held.roster, history[at]!.nativeAgents ?? NONE)) at += 1
    assert.ok(at < history.length, `${where}: roster was never the host's, or went back`)
    seen[window] = at
    if (held.hydrated) {
      const then = history.findLast((snapshot) => snapshot.epoch === held.epoch && snapshot.revision === held.revision)
      assert.ok(then, `${where}: unknown revision ${held.epoch}:${held.revision}`)
      assert.deepEqual(held.roster, then.nativeAgents ?? NONE, `${where}: shown roster differs from host at its revision`)
    }
  }
  const send = async (window: number, command: WindowCommand) => {
    trail.push(`${window} ${command.kind}${command.kind === "batch" ? ` ${command.batch.epoch}:${command.batch.revision}` : ""}`)
    state[window] = await windows[window]!.ask(command)
    for (const read of state[window]!.reads) if (!reads[window]!.has(read.number)) reads[window]!.set(read.number, history.length - 1)
    check(window)
  }
  const step = (force = false) => {
    const before = roster
    const agents = [...(roster?.agents ?? [])]
    const roll = force ? 0 : pick(), at = Math.floor(pick() * agents.length)
    clock += 1
    if (roll < 0.35 && agents.length) { agents[at] = agent(agents[at]!.nativeId, clock); count("changed") }
    else if (roll < 0.47 && agents.length) { agents[at] = { ...agents[at]!, title: `Renamed at ${clock}` }; count("renamed") }
    else if (roll < 0.53 && agents.length) {
      const entry = agents[at]!
      agents[at] = { ...entry, child: entry.child && { ...entry.child, state: { kind: "blocked", on: "person", question: `May I proceed at ${clock}?`, ask: { kind: "report", id: `ask-${clock}` } } } }
      count("asks")
    }
    else if (roll < 0.59) { agents.push(agent(`n${clock}`, clock)); count("added") }
    else if (roll < 0.66) { agents.unshift(agent(`f${clock}`, clock)); count("prepended") }
    else if (roll < 0.75 && agents.length) { agents.splice(at, 1); count("removed") }
    else if (roll < 0.82 && agents.length > 1) { [agents[0], agents[agents.length - 1]] = [agents[agents.length - 1]!, agents[0]!]; count("reordered") }
    if (roll < 0.9) roster = { agents, limited: roll >= 0.82 ? !(roster?.limited ?? false) : roster?.limited ?? false }
    revision += 1
    history.push(snapshot())
    const batch = compactLiveBatch({ id, revision, epoch: epoch(), updates: [], ...(roster !== before && roster && { nativeAgents: roster }) }, { blocks: [], requests: [] })
    const compact = rosteredLiveBatch(batch, before) ?? batch
    count("rosterPatch" in compact ? "patches" : "wholes")
    sent.push(compact)
  }
  for (const window of [0, 1]) await send(window, { kind: "init", snapshot: window === 0 && prior ? { ...snapshot(), nativeAgents: prior } : snapshot(), listed: window === 0 })
  for (let stepAt = 0; stepAt < 100; stepAt += 1) {
    const roll = pick(), window = pick() < 0.5 ? 0 : 1
    if (roll < 0.28) step()
    else if (roll < 0.48) {
      const batch = sent[next[window]!]
      if (batch) { next[window]! += 1; absent[window] = false; await send(window, { kind: "batch", batch }) }
    } else if (roll < 0.53) { next[window] = Math.min(sent.length, next[window]! + 1); count("lost") }
    else if (roll < 0.6) {
      const read = state[window]!.reads[Math.floor(pick() * state[window]!.reads.length)]
      if (read) {
        const how = pick(), asked = reads[window]!.get(read.number)!
        const at = asked + Math.floor(pick() * (history.length - asked))
        await send(window, { kind: "reply", read: read.number, ...(how < 0.15 ? { fail: true } : { snapshot: how < 0.3 ? null : history[at]! }) })
        count(how < 0.15 ? "failedReads" : how < 0.3 ? "nullReads" : "answeredReads")
      }
    } else if (roll < 0.65) { absent[window] = false; await send(window, { kind: "open" }); count("opened") }
    else if (roll < 0.7) { await send(window, { kind: "unload" }); count("letGo") }
    else if (roll < 0.75) { absent[window] = false; await send(window, { kind: "read" }); count("overlappingReads") }
    else if (roll < 0.8) {
      absent[window] = true
      seen[window] = history.length - 1
      await send(window, { kind: "unlist" }); count("unlisted")
    } else if (roll < 0.87) {
      absent[window] = false
      const { session, threadId, createdAt, epoch: start, revision: at } = snapshot()
      await send(window, { kind: "list", summary: { session, threadId, createdAt, epoch: start, revision: at } }); count("listed")
    } else if (roll < 0.92) {
      generation += 1; revision = 1
      history.push(snapshot())
      next.fill(sent.length)
      count("restarts")
    } else {
      const old = sent.filter((batch) => batch.epoch === epoch() && batch.nativeAgents)
      const batch = old[Math.floor(pick() * old.length)]
      if (batch && !absent[window]) { await send(window, { kind: "batch", batch }); count("duplicates") }
    }
  }
  // Reattach both windows, then change the roster once more. Let normal stream recovery converge without opening
  // either conversation: an explicit open would hide a missing repair of a listed window's unread patch.
  const { session, threadId, createdAt } = snapshot()
  for (const window of [0, 1]) {
    absent[window] = false
    await send(window, { kind: "list", summary: { session, threadId, createdAt, epoch: epoch(), revision } })
  }
  step(true)
  for (const window of [0, 1]) {
    for (; next[window]! < sent.length; next[window]! += 1) await send(window, { kind: "batch", batch: sent[next[window]!]! })
    for (let round = 0; state[window]!.reads.length && round < 30; round += 1)
      for (const read of state[window]!.reads) await send(window, { kind: "reply", read: read.number, snapshot: snapshot() })
    assert.equal(state[window]!.reads.length, 0, `seed ${seed}: recovery settled`)
    assert.deepEqual(state[window]!.held?.roster, roster, `seed ${seed}, window ${window}: normal recovery converges to the host; held ${state[window]!.held?.epoch}:${state[window]!.held?.revision}, host ${epoch()}:${revision}; ${trail.slice(-22).join("; ")}`)
  }
}

try {
  for (const seed of seeds) await run(seed)
  if (!only) for (const [name, value] of Object.entries(totals)) assert.ok(value >= seeds.length / 10, `coverage ${name}: ${value}`)
  console.log(`Roster invariant: ${seeds.length} seeds, two real windows; ${JSON.stringify(totals)}`)
} finally { for (const window of windows) window.close() }

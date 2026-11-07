import assert from "node:assert/strict"
import { mock } from "node:test"
import { setImmediate as turn } from "node:timers/promises"
import { NativeAgentSchema, type NativeAgent, type NativeAgentRoster } from "@mako/host/contracts/native-agents"
import { compactLiveBatch, rosteredLiveBatch, type CompactLiveBatch, type LiveBatch, type LiveRoster, type LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { LiveHistoryRead } from "@mako/host/contracts/live-history"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"

/**
 * The one rule a window's roster keeps, however its host's batches reach it (`readRoster`, `rosteredLiveBatch`): it is
 * always the roster the host had at some revision, and that revision never goes back, so no Fin the host still had is
 * dropped and no older state comes back; and once nothing is on its way it is the host's latest. Checked after every
 * step of generated runs, in the real renderer: a host that changes its roster every way (an entry moving, coming last
 * or first, going, entries trading places, the limit reached) and sometimes restarts, and a window that hears each batch
 * as what changed where it can, misses some, hears old whole ones of the same start again, loses its stream, reads whole rosters answered
 * as of any moment since it asked, and opens the conversation and lets it go. `SEEDS=<n>` runs more; a failure names its
 * seed and step, and `SEED=<seed>` runs that one alone.
 */
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { installMockBridge } = await import("../src/dev/mock-bridge")
installMockBridge()
const { getMako } = await import("../src/lib/bridge")
const { AudioFeedback } = await import("../src/lib/audio-feedback")
const { acpStore } = await import("../src/state/acp-state")
const { applyLiveBatch, applyLiveSnapshot, hydrateLive, unloadLive } = await import("../src/state/live-recovery")
mock.method(AudioFeedback.prototype, "play", async () => {})
mock.method(console, "warn", () => {})
const bridge = getMako()

/** mulberry32: the same run from the same seed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const agent = (id: string, at: number, step: string): NativeAgent => NativeAgentSchema.parse({
  bindingId: "binding", provider: "codex", nativeId: id, title: `Worker ${id}, with a title long enough to be worth leaving out of a change`, observedAt: at,
  state: { kind: "working", activity: step }, child: { thread: "11111111-1111-4111-8111-111111111111", origin: "started", name: id, state: { kind: "working", step } },
})

type Pending<Value> = { asked: number; answer: (value: Value) => void }
const rosterAsks: Pending<LiveRoster | null>[] = []
const snapshotAsks: (Pending<LiveSnapshot> & { input: LiveHistoryRead })[] = []
const reader = new LiveHistoryReader()
let host: Host
mock.method(bridge, "liveRoster", () => new Promise<LiveRoster | null>((answer) => rosterAsks.push({ asked: host.revision, answer })))
mock.method(bridge, "liveRead", (id: string, input: LiveHistoryRead) => new Promise<LiveSnapshot>((answer) => snapshotAsks.push({ asked: host.revision, answer, input })).then((snapshot) => reader.read(id, input, async () => snapshot)))

class Host {
  revision = 1
  epoch = "start-1"
  starts = 1
  clock = 1
  roster: NativeAgentRoster = { limited: false, agents: ["a", "b", "c"].map((id) => agent(id, 1, "starting")) }
  /** Each revision's roster and the start that wrote it. */
  readonly history = new Map<number, { roster: NativeAgentRoster; epoch: string }>([[1, { roster: this.roster, epoch: this.epoch }]])
  /** What's on its way to the window, in order. */
  readonly queue: { batch: CompactLiveBatch; whole: CompactLiveBatch }[] = []
  next = 0
  constructor(readonly id: string, readonly pick: () => number) {}

  /** Its snapshot as of `revision`, in the start that wrote it. */
  snapshot(revision = this.revision): LiveSnapshot {
    const as = this.history.get(revision)!
    return {
      session: { id: this.id, harness: "codex", cwd: "/fixture", title: "An Apex", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
      threadId: "22222222-2222-4222-8222-222222222222", createdAt: 1, epoch: as.epoch, revision, base: null, blocks: [], requests: [], permissions: [], nativeAgents: as.roster,
    }
  }

  /** One batch: most change the roster, some anything else. */
  step(): void {
    const before = this.roster
    const agents = [...before.agents]
    const roll = this.pick()
    this.clock += 1
    const at = Math.floor(this.pick() * agents.length)
    let limited = before.limited
    if (roll < 0.5 && agents.length) agents[at] = agent(agents[at]!.nativeId, this.clock, `step ${this.clock}`)
    else if (roll < 0.6) agents.push(agent(`n${this.clock}`, this.clock, "new"))
    else if (roll < 0.66) agents.unshift(agent(`f${this.clock}`, this.clock, "new, first"))
    else if (roll < 0.74 && agents.length > 1) agents.splice(at, 1)
    else if (roll < 0.8 && agents.length > 1) [agents[0], agents[agents.length - 1]] = [agents[agents.length - 1]!, agents[0]!]
    else if (roll < 0.83) limited = !limited
    const changed = roll < 0.83
    this.revision += 1
    if (changed) this.roster = { limited, agents }
    this.history.set(this.revision, { roster: this.roster, epoch: this.epoch })
    const batch: LiveBatch = { id: this.id, revision: this.revision, epoch: this.epoch, updates: [], ...(changed && { nativeAgents: this.roster }) }
    const whole = compactLiveBatch(batch, { blocks: [], requests: [] })
    this.queue.push({ batch: (changed && rosteredLiveBatch(whole, before)) || whole, whole })
  }

  /**
   * A host that restarts ends its stream: what it hadn't sent is lost with it, and the window hears the new one's after.
   * A read still out is answered by the new one, as of its own state, never by the one that's gone.
   */
  restart(): void {
    this.starts += 1
    this.epoch = `start-${this.starts}`
    this.next = this.queue.length
    for (const ask of [...rosterAsks, ...snapshotAsks]) ask.asked = this.revision + 1
  }
}

const held = (id: string) => {
  const current = acpStore.get().conversations[id]
  return current?.kind === "live" ? current : undefined
}
const settle = async () => {
  for (let wait = 0; wait < 4; wait += 1) await turn()
}

async function run(seed: number, steps: number): Promise<{ reads: number; patches: number; wholes: number }> {
  const pick = random(seed)
  const id = `roster-${seed}`
  host = new Host(id, pick)
  rosterAsks.length = 0
  snapshotAsks.length = 0
  applyLiveSnapshot(host.snapshot())
  unloadLive(id)
  acpStore.set({ activeKey: null })
  let seen = 1, reads = 0, patches = 0, wholes = 0
  const trail: string[] = []
  const check = (what: string) => {
    const roster = held(id)?.nativeAgents
    const text = JSON.stringify(roster)
    let at = seen
    while (at <= host.revision && JSON.stringify(host.history.get(at)?.roster) !== text) at += 1
    assert.ok(at <= host.revision, `seed ${seed}, after ${what}: the window's roster is none the host had since revision ${seen}\n${trail.slice(-12).join("\n")}\nholds ${roster?.agents.map((each) => `${each.nativeId}@${each.observedAt}`).join(" ")}`)
    seen = at
  }
  /** A read the host can answer now: one asked of a host that restarted waits for the new one's first revision. */
  const answerable = <Ask extends { asked: number }>(asks: Ask[]): Ask | undefined => {
    const at = asks.findIndex((ask) => ask.asked <= host.revision)
    return at < 0 ? undefined : asks.splice(at, 1)[0]
  }
  const answerRoster = async () => {
    const ask = answerable(rosterAsks)
    if (!ask) return
    reads += 1
    // As of any moment since it was asked, in the start that answers.
    const revision = ask.asked + Math.floor(pick() * (host.revision - ask.asked + 1))
    const told = host.history.get(revision)!
    trail.push(`answer a roster read as of ${revision}`)
    ask.answer({ roster: told.roster, revision, epoch: told.epoch })
    await settle()
  }
  for (let step = 0; step < steps; step += 1) {
    const roll = pick()
    if (roll < 0.3) {
      host.step()
      trail.push(`host to ${host.revision}`)
      continue
    }
    if (roll < 0.62) {
      const next = host.queue[host.next]
      if (!next) continue
      host.next += 1
      if (next.batch.rosterPatch) patches += 1
      else if (next.batch.nativeAgents) wholes += 1
      trail.push(`hear ${next.batch.revision}${next.batch.rosterPatch ? " as what changed" : next.batch.nativeAgents ? " whole" : ""}`)
      applyLiveBatch(next.batch)
    } else if (roll < 0.67) {
      if (host.next < host.queue.length) trail.push(`miss ${host.queue[host.next]!.batch.revision}`)
      host.next = Math.min(host.queue.length, host.next + 1)
    } else if (roll < 0.74) {
      // A whole batch again, as a stream that repeats one would, mostly one just heard: of this start of the host, since
      // a stream is in order, and one from before a restart can't follow the restart (a start's numbers may be used again).
      const old = host.queue.slice(0, host.next).filter((each) => each.whole.nativeAgents && each.whole.epoch === host.epoch)
      const again = old[pick() < 0.7 ? old.length - 1 - Math.floor(pick() * Math.min(3, old.length)) : Math.floor(pick() * old.length)]
      if (!again) continue
      trail.push(`hear ${again.whole.revision} whole again`)
      applyLiveBatch(again.whole)
    } else if (roll < 0.86) {
      await answerRoster()
    } else if (roll < 0.9) {
      trail.push(`lose the stream at ${host.next}`)
      host.next = host.queue.length
    } else if (roll < 0.93) {
      host.restart()
      trail.push(`host restarts as ${host.epoch}`)
    } else if (roll < 0.96) {
      if (held(id)?.hydrated) {
        acpStore.set({ activeKey: null })
        trail.push(`let it go: ${String(unloadLive(id))}`)
      } else {
        trail.push("open it")
        void hydrateLive(id)
      }
    } else {
      const ask = answerable(snapshotAsks)
      if (!ask) continue
      // As of any moment since it was asked, as a roster read is.
      const revision = ask.asked + Math.floor(pick() * (host.revision - ask.asked + 1))
      trail.push(`answer a snapshot read as of ${revision}`)
      ask.answer(host.snapshot(revision))
    }
    await settle()
    check(trail.at(-1)!)
  }
  // Nothing more on its way: everything heard, every read answered, then the next change, whole.
  for (; host.next < host.queue.length; host.next += 1) applyLiveBatch(host.queue[host.next]!.batch)
  await settle()
  if (rosterAsks.length || snapshotAsks.length) host.step()
  for (; host.next < host.queue.length; host.next += 1) applyLiveBatch(host.queue[host.next]!.batch)
  while (rosterAsks.length || snapshotAsks.length) {
    await answerRoster()
    answerable(snapshotAsks)?.answer(host.snapshot())
    await settle()
  }
  check("everything arrived")
  host.roster = { ...host.roster, agents: [agent(`last-${seed}`, host.clock + 1, "last"), ...host.roster.agents] }
  host.revision += 1
  host.history.set(host.revision, { roster: host.roster, epoch: host.epoch })
  applyLiveBatch(compactLiveBatch({ id, revision: host.revision, epoch: host.epoch, updates: [], nativeAgents: host.roster }, { blocks: [], requests: [] }))
  await settle()
  while (rosterAsks.length || snapshotAsks.length) {
    await answerRoster()
    answerable(snapshotAsks)?.answer(host.snapshot())
    await settle()
  }
  assert.deepEqual(held(id)?.nativeAgents, host.roster, `seed ${seed}: once nothing is on its way the window holds the host's roster\n${trail.slice(-12).join("\n")}`)
  return { reads, patches, wholes }
}

const only = process.env.SEED
const seeds = only ? [Number(only)] : Array.from({ length: Number(process.env.SEEDS ?? 300) }, (_, at) => at + 1)
const totals = { reads: 0, patches: 0, wholes: 0 }
for (const seed of seeds) {
  const counts = await run(seed, 120)
  totals.reads += counts.reads
  totals.patches += counts.patches
  totals.wholes += counts.wholes
}
// The runs have to have tried what they're for.
assert.ok(totals.patches > seeds.length * 3 && totals.wholes > seeds.length && totals.reads > seeds.length, JSON.stringify(totals))
console.log(`Roster invariant: over ${seeds.length} generated runs, a window's roster was always one its host had, never older than the last, and the host's at the end (${totals.patches} changes, ${totals.wholes} whole rosters, ${totals.reads} roster reads answered)`)
process.exit(0)

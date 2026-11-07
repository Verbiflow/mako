import assert from "node:assert/strict"
import { mock } from "node:test"
import { setImmediate as turn } from "node:timers/promises"
import { NativeAgentSchema, type NativeAgent, type NativeAgentRoster } from "@mako/host/contracts/native-agents"
import { compactLiveBatch, rosteredLiveBatch, type CompactLiveBatch, type LiveBatch, type LiveSnapshot, type LiveSummary } from "@mako/host/contracts/live-conversations"
import type { LiveHistoryRead } from "@mako/host/contracts/live-history"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"

/**
 * What a window's roster keeps, however its host's batches reach it (`rosteredLiveBatch`, `applyLiveBatch`,
 * `askWholeRoster`), checked after every step of generated runs in the real renderer:
 * - it is always a roster its host had, and never one older than a roster it held since it last had none;
 * - a conversation it shows holds exactly the roster its host had at the revision it's at;
 * - once everything sent has arrived, every ask is answered and the roster's next change has gone out, it is the host's.
 *
 * The host changes its roster every way (an entry moving, coming last or first, going, entries trading places, the limit
 * reached), may have none until its first Fin, sends it whole when a window asks (this one, or another window, at any
 * time), and restarts with its numbers begun again, losing what it hadn't sent. The window hears each batch in a host's
 * own windows' form, misses some, hears old whole ones of the same start again, loses its stream, asks for a roster
 * whole and has the ask fail or come back unanswerable, opens the conversation and lets it go, and has it let go of by
 * the account's list and listed again with no roster. `SEEDS=<n>` runs more than CI's 300; a failure names its seed and
 * step, and `SEED=<seed>` runs that one alone.
 */
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { installMockBridge } = await import("../src/dev/mock-bridge")
installMockBridge()
const { getMako } = await import("../src/lib/bridge")
const { AudioFeedback } = await import("../src/lib/audio-feedback")
const { acpStore } = await import("../src/state/acp-state")
const { applyLiveBatch, applyLiveSnapshot, hydrateLive, listLive, unlistLive, unloadLive } = await import("../src/state/live-recovery")
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
const NONE: NativeAgentRoster = { agents: [], limited: false }
/** What a roster says to a surface: a host with none says an empty one when asked. */
const said = (roster: NativeAgentRoster | undefined) => JSON.stringify(roster ?? NONE)

type Ask = { answer: (sent: boolean) => void; fail: () => void }
const asks: Ask[] = []
const snapshotAsks: { epoch: string; asked: number; answer: (snapshot: LiveSnapshot) => void }[] = []
const reader = new LiveHistoryReader()
let host: Host
mock.method(bridge, "liveRoster", () => new Promise<boolean>((answer, reject) => asks.push({ answer, fail: () => reject(new Error("The host isn't answering")) })))
mock.method(bridge, "liveRead", (id: string, input: LiveHistoryRead) => new Promise<LiveSnapshot>((answer) => snapshotAsks.push({ epoch: host.epoch, asked: host.revision, answer })).then((snapshot) => reader.read(id, input, async () => snapshot)))

class Host {
  revision = 1
  epoch = "start-1"
  starts = 1
  clock = 1
  roster: NativeAgentRoster | undefined
  /** Every roster it had, in the order it had them, with the start and revision of each. */
  readonly had: { epoch: string; revision: number; roster: NativeAgentRoster | undefined }[] = []
  /** What's on its way to the window, in order: as a host's own windows hear it, and whole. */
  readonly queue: { batch: CompactLiveBatch; whole: CompactLiveBatch }[] = []
  next = 0
  /** A window asked for the roster whole: the next batch says it. */
  asked = false
  constructor(readonly id: string, readonly pick: () => number) {
    this.roster = pick() < 0.3 ? undefined : { limited: false, agents: ["a", "b", "c"].map((id) => agent(id, 1, "starting")) }
    this.had.push({ epoch: this.epoch, revision: this.revision, roster: this.roster })
  }

  at(epoch: string, revision: number): { roster: NativeAgentRoster | undefined } | undefined {
    return this.had.findLast((each) => each.epoch === epoch && each.revision <= revision)
  }

  snapshot(revision = this.revision): LiveSnapshot {
    const roster = this.at(this.epoch, revision)?.roster
    return {
      session: { id: this.id, harness: "codex", cwd: "/fixture", title: "An Apex", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
      threadId: "22222222-2222-4222-8222-222222222222", createdAt: 1, epoch: this.epoch, revision, base: null, blocks: [], requests: [], permissions: [], ...(roster && { nativeAgents: roster }),
    }
  }

  /** One batch: most change the roster, some anything else (`change`: always, or never); the one after an ask says it whole. */
  step(change: "maybe" | "always" | "never" = "maybe"): void {
    const before = this.roster
    const agents = [...(before?.agents ?? [])]
    const roll = change === "never" ? 1 : change === "always" ? 0.55 : this.pick()
    this.clock += 1
    const at = Math.floor(this.pick() * agents.length)
    let limited = before?.limited ?? false
    if (roll < 0.5 && agents.length) agents[at] = agent(agents[at]!.nativeId, this.clock, `step ${this.clock}`)
    else if (roll < 0.6) agents.push(agent(`n${this.clock}`, this.clock, "new"))
    else if (roll < 0.66) agents.unshift(agent(`f${this.clock}`, this.clock, "new, first"))
    else if (roll < 0.74 && agents.length > 1) agents.splice(at, 1)
    else if (roll < 0.8 && agents.length > 1) [agents[0], agents[agents.length - 1]] = [agents[agents.length - 1]!, agents[0]!]
    else if (roll < 0.83) limited = !limited
    const changed = roll < 0.83
    this.revision += 1
    if (changed) this.roster = { limited, agents }
    this.had.push({ epoch: this.epoch, revision: this.revision, roster: this.roster })
    const whole = this.asked
    this.asked = false
    const nativeAgents = whole ? (this.roster ?? NONE) : changed ? this.roster : undefined
    const batch: LiveBatch = { id: this.id, revision: this.revision, epoch: this.epoch, updates: [], ...(nativeAgents && { nativeAgents }) }
    const compact = compactLiveBatch(batch, { blocks: [], requests: [] })
    this.queue.push({ batch: (!whole && changed && rosteredLiveBatch(compact, before)) || compact, whole: compact })
  }

  /**
   * A host that restarts ends its stream, and what it hadn't sent goes with it; the new one numbers from 1 again and
   * answers what's asked of it as of its own state.
   */
  restart(): void {
    this.starts += 1
    this.epoch = `start-${this.starts}`
    this.revision = 1
    this.asked = false
    this.next = this.queue.length
    this.had.push({ epoch: this.epoch, revision: this.revision, roster: this.roster })
    for (const ask of snapshotAsks) {
      ask.epoch = this.epoch
      ask.asked = this.revision
    }
  }
}

const held = (id: string) => {
  const current = acpStore.get().conversations[id]
  return current?.kind === "live" ? current : undefined
}
const settle = async () => {
  for (let wait = 0; wait < 4; wait += 1) await turn()
}

async function run(seed: number, steps: number): Promise<Record<string, number>> {
  const pick = random(seed)
  const id = `roster-${seed}`
  host = new Host(id, pick)
  asks.length = 0
  snapshotAsks.length = 0
  applyLiveSnapshot(host.snapshot())
  unloadLive(id)
  acpStore.set({ activeKey: null })
  const counts = { patches: 0, wholes: 0, asks: 0, failed: 0, unanswerable: 0, others: 0, relisted: 0, restarts: 0, shown: 0 }
  /** The earliest of the host's rosters the window may hold: none older than one it held since it last held none. */
  let seen = 0
  const trail: string[] = []
  const check = (what: string) => {
    const conversation = held(id)
    const roster = conversation?.nativeAgents
    const where = () => `seed ${seed}, after ${what}:\n${trail.slice(-14).join("\n")}\nholds ${roster ? roster.agents.map((each) => `${each.nativeId}@${each.observedAt}`).join(" ") : "none"}`
    if (roster === undefined) return
    let at = seen
    while (at < host.had.length && said(host.had[at]!.roster) !== JSON.stringify(roster)) at += 1
    assert.ok(at < host.had.length, `${where()}\nthe window's roster is none its host had since the one it held`)
    seen = at
    // One it shows is exactly the host's at its revision: every change it took read against the one before.
    if (conversation?.hydrated && conversation.epoch !== undefined) {
      const then = host.at(conversation.epoch, conversation.revision ?? 0)
      if (then) assert.equal(JSON.stringify(roster), said(then.roster), `${where()}\na shown conversation's roster isn't its host's at revision ${String(conversation.revision)}`)
    }
  }
  const hear = (batch: CompactLiveBatch) => {
    if (batch.rosterPatch) counts.patches += 1
    else if (batch.nativeAgents) counts.wholes += 1
    applyLiveBatch(batch)
  }
  for (let step = 0; step < steps; step += 1) {
    const roll = pick()
    if (roll < 0.27) {
      host.step()
      trail.push(`host to ${host.revision}`)
      continue
    }
    if (roll < 0.55) {
      const next = host.queue[host.next]
      if (!next) continue
      host.next += 1
      trail.push(`hear ${next.batch.revision}${next.batch.rosterPatch ? " as what changed" : next.batch.nativeAgents ? " whole" : ""}`)
      hear(next.batch)
    } else if (roll < 0.59) {
      if (host.next < host.queue.length) trail.push(`miss ${host.queue[host.next]!.batch.revision}`)
      host.next = Math.min(host.queue.length, host.next + 1)
    } else if (roll < 0.63) {
      // A whole batch again, as a stream that repeats one would, of this start: a stream is in order, and one from before
      // a restart can't follow it.
      const old = host.queue.slice(0, host.next).filter((each) => each.whole.nativeAgents && each.whole.epoch === host.epoch)
      const again = old[Math.floor(pick() * old.length)]
      if (!again) continue
      trail.push(`hear ${again.whole.revision} whole again`)
      applyLiveBatch(again.whole)
    } else if (roll < 0.75) {
      // The window's ask reaches the host: answered (its next batch says the roster whole), failed, or unanswerable.
      const ask = asks.shift()
      if (!ask) continue
      counts.asks += 1
      const how = pick()
      if (how < 0.75) {
        host.asked = true
        trail.push("answer an ask")
        ask.answer(true)
      } else if (how < 0.9) {
        counts.failed += 1
        trail.push("fail an ask")
        ask.fail()
      } else {
        counts.unanswerable += 1
        trail.push("answer an ask: not here")
        ask.answer(false)
      }
    } else if (roll < 0.79) {
      // Another window asks: what it's sent, this one hears too.
      counts.others += 1
      host.asked = true
      host.step("never")
      trail.push(`another window asks: ${host.revision} whole`)
    } else if (roll < 0.82) {
      trail.push(`lose the stream at ${host.next}`)
      host.next = host.queue.length
    } else if (roll < 0.85) {
      counts.restarts += 1
      host.restart()
      trail.push(`host restarts as ${host.epoch}`)
    } else if (roll < 0.89) {
      // The account's list lets it go and lists it again, as of the host's revision then, with no roster.
      const current = held(id)
      if (!current || current.hydrated || snapshotAsks.length) continue
      counts.relisted += 1
      unlistLive([id])
      listLive([{ session: current.session, revision: host.revision, epoch: host.epoch, threadId: current.threadId, createdAt: 1 } as LiveSummary])
      seen = host.had.length - 1
      trail.push(`listed again at ${host.revision}`)
    } else if (roll < 0.94) {
      if (held(id)?.hydrated) {
        acpStore.set({ activeKey: null })
        trail.push(`let it go: ${String(unloadLive(id))}`)
      } else {
        counts.shown += 1
        trail.push("open it")
        void hydrateLive(id)
      }
    } else {
      const ask = snapshotAsks.find((each) => each.epoch === host.epoch)
      if (!ask) continue
      snapshotAsks.splice(snapshotAsks.indexOf(ask), 1)
      // As of any moment since it was asked.
      const revision = ask.asked + Math.floor(pick() * (host.revision - ask.asked + 1))
      trail.push(`answer a snapshot read as of ${revision}`)
      ask.answer(host.snapshot(revision))
    }
    await settle()
    check(trail.at(-1)!)
  }
  // Nothing more on its way: everything sent arrives, every read is answered, each ask brings the roster whole, and the
  // next change goes out as what changed.
  const drain = async () => {
    for (let round = 0; round < 20; round += 1) {
      for (; host.next < host.queue.length; host.next += 1) hear(host.queue[host.next]!.batch)
      await settle()
      const snapshot = snapshotAsks.shift()
      if (snapshot) snapshot.answer(host.snapshot())
      const ask = asks.shift()
      if (ask) {
        host.asked = true
        ask.answer(true)
        host.step("never")
      }
      await settle()
      if (!snapshot && !ask && host.next === host.queue.length) return
    }
  }
  await drain()
  check("everything arrived")
  // A batch it missed that changed the roster, then batches saying nothing of it: a conversation it only lists can't
  // know, so it's the next change to the roster that mends it, as with whole rosters.
  host.step("always")
  await drain()
  check("the next change")
  assert.equal(JSON.stringify(held(id)?.nativeAgents ?? NONE), said(host.roster), `seed ${seed}: once nothing is on its way the window holds the host's roster\n${trail.slice(-14).join("\n")}`)
  return counts
}

const only = process.env.SEED
const seeds = only ? [Number(only)] : Array.from({ length: Number(process.env.SEEDS ?? 300) }, (_, at) => at + 1)
const totals: Record<string, number> = {}
for (const seed of seeds) for (const [name, count] of Object.entries(await run(seed, 150))) totals[name] = (totals[name] ?? 0) + count
// The runs have to have tried what they're for.
if (!only) for (const [name, count] of Object.entries(totals)) assert.ok(count >= seeds.length / 10, `too few ${name}: ${JSON.stringify(totals)}`)
console.log(`Roster invariant: over ${seeds.length} generated runs, a window's roster was always one its host had, never older than one it held, exactly its host's where shown, and its host's at the end (${Object.entries(totals).map(([name, count]) => `${count} ${name}`).join(", ")})`)
process.exit(0)

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { childEntry, ThreadParentSchema } from "@mako/host/contracts/agents"
import { NativeAgentSchema, type NativeAgent } from "@mako/host/contracts/native-agents"
import type { LiveBatch, LiveSnapshot } from "@mako/host/contracts/live-conversations"

/**
 * Every ask said to the person on one Apex's subject stands for exactly as long as it's open: the notices the attention
 * centre shows for it are exactly the asks still open, in every order. Checked after every step of generated runs, in
 * the real renderer (`applyLiveBatch`, `applyLiveSnapshot`, `noteFinAsks`, `syncThreadStatus`, the notification store),
 * over three askers on one subject, the Apex itself and two of its Fins, each asking an approval or a question, opened
 * and answered in any order, an Apex's ask replaced by another, the Apex starting a turn and ending it, its window
 * recovering from a snapshot, and the Session leaving the window (where, held nowhere, what it asked is unknown and
 * isn't checked) and coming back from a snapshot. `SEEDS=<n>` runs more than CI's 300; a failure names its seed and step,
 * and `SEED=<seed>` runs that one alone.
 */
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { acpStore, removeAcpConversation } = await import("../src/state/acp-state")
const { applyLiveBatch, applyLiveSnapshot, unloadLive } = await import("../src/state/live-recovery")
const { notificationsStore, subjectId } = await import("../src/state/notifications")
const { applyThreadGroupChange } = await import("../src/state/thread-groups")

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

type Kind = "approval" | "question"
type Ask = { id: string; kind: Kind }
const ASKERS = ["apex", "a", "b"] as const
/** What each asker waits on the person for now, as its host has it. */
type OpenAsks = { [asker in (typeof ASKERS)[number]]?: Ask }

async function run(seed: number, steps: number): Promise<Record<string, number>> {
  const pick = random(seed)
  const choose = <Value>(values: readonly Value[]) => values[Math.floor(pick() * values.length)]!
  const thread = randomUUID(), session = randomUUID(), key = `apex-${seed}`
  const subject = subjectId({ kind: "live", key })
  const fins = { a: randomUUID(), b: randomUUID() }
  const quiet = (fin: "a" | "b") => childEntry(ThreadParentSchema.parse({
    child: fins[fin], parent: thread, parentSession: session, name: `fin-${fin}`, role: "worker", origin: "started",
    asked: { brief: { objective: "Work" }, harness: "claude" }, op: `start-${fin}`, startedBy: { kind: "agent", session }, createdAt: 1,
  }), { source: "live" }, {})
  const open: OpenAsks = {}
  const host = { revision: 1, running: false, open }
  let held = true
  let counter = 0
  const counts = { opened: 0, answered: 0, replaced: 0, turns: 0, snapshots: 0, removed: 0, both: 0 }

  const roster = () => ({
    limited: false,
    agents: (["a", "b"] as const).map((fin): NativeAgent => {
      const ask = host.open[fin]
      const entry = quiet(fin)
      return ask ? NativeAgentSchema.parse({ ...entry, child: { ...entry.child!, state: { kind: "blocked", question: `Fin ${fin} asks ${ask.id}`, on: "person", ask: { kind: ask.kind, id: ask.id, options: [{ label: "Yes" }, { label: "No" }] } } } }) : entry
    }),
  })
  const permissions = () => {
    const ask = host.open.apex
    // SAFETY: a permission request as the window reads it: its id, its words, and for a question, the question.
    return ask ? [{ id: ask.id, observationId: ask.id, sessionId: key, title: `Run ${ask.id}`, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], ...(ask.kind === "question" && { questions: [{ question: `Which ${ask.id}?` }] }) } as never] : []
  }
  const session$ = () => ({ id: key, harness: "codex", cwd: "/fixture", title: "An Apex", status: host.running ? "running" as const : "ready" as const, connection: "connected" as const, modes: [], currentMode: null, configOptions: [] })
  const snapshot = (): LiveSnapshot => ({
    session: session$(), threadId: thread, sessionId: session, epoch: "E", revision: host.revision, createdAt: 1, blocks: [], requests: [], permissions: permissions(), base: null, nativeAgents: roster(),
  })
  /** What the host sends as it changes: to this window only while it holds the Session. */
  const send = (what: Partial<LiveBatch>) => {
    host.revision += 1
    if (held) applyLiveBatch({ id: key, revision: host.revision, epoch: "E", updates: [], ...what })
  }
  const trail: string[] = []
  const check = (what: string) => {
    if (!held) return
    const expected = ASKERS.flatMap((asker) => {
      const ask = host.open[asker]
      if (!ask) return []
      return [asker === "apex" ? `${subject}:${ask.kind}:${ask.id}` : `${subject}:${ask.kind}:fin:${fins[asker]}:${ask.id}`]
    }).sort()
    const shown = notificationsStore.get().items.filter((item) => !item.seen && item.subject.id === subject && ["approval", "question", "needs-you"].includes(item.kind)).map((item) => item.id).sort()
    assert.deepEqual(shown, expected, `seed ${seed}, after ${what}: the notices shown aren't the asks open\n${trail.slice(-14).join("\n")}`)
    if (expected.length > 1) counts.both += 1
  }

  notificationsStore.set({ items: [] })
  acpStore.set({ activeKey: null, conversations: {} })
  applyThreadGroupChange({ thread, group: null })
  applyLiveSnapshot(snapshot())
  unloadLive(key)
  for (let step = 0; step < steps; step += 1) {
    const roll = pick()
    const asker = choose(ASKERS)
    if (roll < 0.45) {
      // Open an ask, or replace the Apex's own with another.
      const ask = { id: `q${(counter += 1)}`, kind: choose(["approval", "question"] as const) }
      if (host.open[asker] && asker !== "apex") continue
      if (host.open[asker]) counts.replaced += 1
      else counts.opened += 1
      host.open[asker] = ask
      trail.push(`${asker} asks ${ask.kind} ${ask.id}`)
      send(asker === "apex" ? { permissions: permissions() } : { nativeAgents: roster() })
    } else if (roll < 0.8) {
      const ask = host.open[asker]
      if (!ask) continue
      counts.answered += 1
      host.open[asker] = undefined
      trail.push(`${asker}'s ${ask.id} answered`)
      send(asker === "apex" ? { permissions: [] } : { nativeAgents: roster() })
    } else if (roll < 0.88) {
      counts.turns += 1
      host.running = !host.running
      trail.push(host.running ? "the Apex starts a turn" : "its turn ends")
      send({ session: session$() })
    } else if (roll < 0.94) {
      if (!held) continue
      counts.removed += 1
      held = false
      removeAcpConversation(key)
      trail.push("the Session leaves the window")
      continue
    } else {
      counts.snapshots += 1
      held = true
      trail.push(`a snapshot at ${host.revision}`)
      applyLiveSnapshot(snapshot())
      unloadLive(key)
      acpStore.set({ activeKey: null })
    }
    check(trail.at(-1)!)
  }
  if (!held) {
    held = true
    applyLiveSnapshot(snapshot())
  }
  check("the end")
  return counts
}

const only = process.env.SEED
const seeds = only ? [Number(only)] : Array.from({ length: Number(process.env.SEEDS ?? 300) }, (_, at) => at + 1)
const totals: Record<string, number> = {}
for (const seed of seeds) for (const [name, count] of Object.entries(await run(seed, 80))) totals[name] = (totals[name] ?? 0) + count
// The runs have to have tried what they're for.
if (!only) for (const [name, count] of Object.entries(totals)) assert.ok(count >= seeds.length / 10, `too few ${name}: ${JSON.stringify(totals)}`)
console.log(`Ask notices: over ${seeds.length} generated runs, the notices shown on an Apex's subject were exactly its own and its Fins' asks still open after every step (${Object.entries(totals).map(([name, count]) => `${count} ${name}`).join(", ")})`)
process.exit(0)

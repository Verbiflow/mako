import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { setImmediate as turn } from "node:timers/promises"
import { childEntry, ThreadParentSchema } from "@mako/host/contracts/agents"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { NativeAgentSchema, type NativeAgent } from "@mako/host/contracts/native-agents"
import type { LiveBatch, LiveSnapshot, LiveSummary } from "@mako/host/contracts/live-conversations"

/**
 * Every ask said to the person stands for exactly as long as it's open: after every step of generated runs, each ask
 * still open has its notice in the attention centre, and no notice the person hasn't seen stands for an ask that isn't;
 * and no Session goes back to a revision older than one the window took of it, shown, listed or let go, since what was
 * answered by then would be asked again.
 * In the real renderer (`applyLiveBatch`, `applyLiveSnapshot`, `hydrateLiveSummaries`, `applyThreadActivity`, the
 * notification store and its visibility), over every source of an ask:
 * - an Apex Thread of two Sessions, older and newest, each with its own approval or question and its own sign-out;
 * - two Fins asking approvals and questions, heard by the newest Session alone, as the host sends them (`finReaders`);
 * - a Session another device runs, listed here, asking as its account's list says;
 * - an app outside Mako waiting on the person.
 * Asks open, are answered, and replace one another in any order; a Session starts and ends turns; reads of a Session
 * go out and are answered late and out of order, after newer batches; the window opens a Session and lets it go, loses
 * it and lists it again; and the person looks at one subject or another. What the window can't know isn't checked: a
 * Session's own asks while it holds none of that Session, and the Fins' while it doesn't hold the newest, which alone
 * hears them. `SEEDS=<n>` runs more than CI's 300; a failure names its seed and step, and `SEED=<seed>` runs that one.
 */
/** The window's bridge: each read of a Session waits in the run's queue to be answered, late and in any order. */
let readSnapshot: (id: string) => Promise<LiveSnapshot> = async () => { throw new Error("no run") }
Object.defineProperty(globalThis, "window", { value: { mako: { liveSnapshot: (id: string) => readSnapshot(id), livePermission: async () => {} } }, configurable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { acpStore, removeAcpConversation } = await import("../src/state/acp-state")
const { applyLiveBatch, applyLiveSnapshot, hydrateLive, hydrateLiveSummaries, listLive, unloadLive } = await import("../src/state/live-recovery")
const { installNotificationEnvironment, notificationsStore, reconcileVisible, subjectId } = await import("../src/state/notifications")
const { applyThreadGroupChange } = await import("../src/state/thread-groups")
const { applyThreadActivity } = await import("../src/state/threads")
const { answerLiveApproval } = await import("../src/state/live-approvals")

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
/** One Session of the Apex Thread, as its host has it at one revision. */
type SessionState = { own?: Ask; signIn?: number; running: boolean }
const SESSIONS = ["older", "newest"] as const
type Session = (typeof SESSIONS)[number]
const FINS = ["a", "b"] as const
type Fin = (typeof FINS)[number]
/** Something of each Session of the Apex Thread. */
interface BySession<Value> { older: Value; newest: Value }
/** What each Fin asks the person now, if anything. */
interface FinAsks { a?: Ask; b?: Ask }
/** What the Session another device runs and the app outside Mako ask now, if anything. */
interface OtherAsks { remote?: Ask; outside?: number }

// The person looks at whichever subjects the run says, the window focused.
let visible = new Set<string>()
installNotificationEnvironment({
  visibleSubjects: () => visible, focused: () => true, now: () => Date.now(), cue: () => {}, toast: () => {}, dismissToast: () => {},
  desktop: async () => true, dismissDesktop: () => {}, badge: () => {}, schedule: () => () => {}, open: () => {}, announces: () => true,
})

async function run(seed: number, steps: number): Promise<Record<string, number>> {
  const pick = random(seed)
  const choose = <Value>(values: readonly Value[]) => values[Math.floor(pick() * values.length)]!
  const thread = ThreadIdSchema.parse(randomUUID())
  const ids = { older: SessionIdSchema.parse(randomUUID()), newest: SessionIdSchema.parse(randomUUID()) }
  const keys = { older: `older-${seed}`, newest: `newest-${seed}` }
  const remote = `remote-${seed}`, outside = `/outside/${seed}.jsonl`
  const subjects = { older: subjectId({ kind: "live", key: keys.older }), newest: subjectId({ kind: "live", key: keys.newest }), remote: subjectId({ kind: "live", key: remote }), outside: subjectId({ kind: "thread", path: outside }) }
  const finIds = { a: randomUUID(), b: randomUUID() }
  const quiet = (fin: Fin) => childEntry(ThreadParentSchema.parse({
    child: finIds[fin], parent: thread, parentSession: ids.older, name: `fin-${fin}`, role: "worker", origin: "started",
    asked: { brief: { objective: "Work" }, harness: "claude" }, op: `start-${fin}`, startedBy: { kind: "agent", session: ids.older }, createdAt: 1,
  }), { source: "live" }, {})
  let counter = 0
  const next = (prefix: string) => `${prefix}${(counter += 1)}`
  const counts = { asked: 0, answered: 0, replaced: 0, turns: 0, lateReads: 0, staleReads: 0, opened: 0, letGo: 0, removed: 0, looked: 0, several: 0 }

  // The host: each Session's state by revision, the Fins (told to the newest alone), the remote Session, the outside app.
  const revisions: BySession<number> = { older: 1, newest: 1 }
  const history: BySession<Map<number, SessionState>> = { older: new Map(), newest: new Map() }
  const fins: FinAsks = {}
  // What the remote Session and the outside app ask, kept beside the Apex Thread's Sessions.
  const others: OtherAsks = {}
  const host = { revision: revisions, history, fins, finsAt: new Map<number, FinAsks>(), remote: others.remote, outside: others.outside }
  for (const session of SESSIONS) host.history[session].set(1, { running: false })
  host.finsAt.set(1, {})
  const now = (session: Session) => host.history[session].get(host.revision[session])!
  const roster = (fins: FinAsks) => ({
    limited: false,
    agents: FINS.map((fin): NativeAgent => {
      const ask = fins[fin]
      const entry = quiet(fin)
      return ask ? NativeAgentSchema.parse({ ...entry, child: { ...entry.child!, state: { kind: "blocked", question: `Fin ${fin} asks ${ask.id}`, on: "person", ask: { kind: ask.kind, id: ask.id, options: [{ label: "Yes" }, { label: "No" }] } } } }) : entry
    }),
  })
  const permissions = (state: SessionState) => {
    if (!state.own) return []
    // SAFETY: a permission request as the window reads it: its id, its words, and for a question, the question.
    return [{ id: state.own.id, observationId: state.own.id, sessionId: "s", title: `Run ${state.own.id}`, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], ...(state.own.kind === "question" && { questions: [{ question: `Which ${state.own.id}?` }] }) } as never]
  }
  const requests = (state: SessionState) => {
    if (!state.signIn) return []
    // SAFETY: a message held on a sign-out as the window reads it: its id, its state and its hold.
    return [{ id: `held-${state.signIn}`, text: "Go on", attachments: [], status: "held", createdAt: 1, signIn: { harness: "codex", account: "me", credential: "c", at: state.signIn } } as never]
  }
  const sessionOf = (session: Session, state: SessionState) => ({ id: keys[session], harness: "codex", cwd: "/fixture", title: `The ${session} Session`, status: state.running ? "running" as const : "ready" as const, connection: "connected" as const, modes: [], currentMode: null, configOptions: [] })
  const snapshot = (session: Session, revision = host.revision[session]): LiveSnapshot => {
    const state = host.history[session].get(revision)!
    // The older Session never hears the Fins: its roster is theirs as it read them in, before any asked.
    const fins = session === "newest" ? host.finsAt.get(revision)! : {}
    return { session: sessionOf(session, state), threadId: thread, sessionId: ids[session], epoch: "E", revision, createdAt: session === "older" ? 1 : 2, blocks: [], requests: requests(state), permissions: permissions(state), base: null, nativeAgents: roster(fins) }
  }
  /** What the window holds of each Session: not at all, listed, or shown. */
  const held = (session: Session) => acpStore.get().conversations[keys[session]]?.kind === "live"
  const heldRevision = (session: Session) => acpStore.get().conversations[keys[session]]?.revision
  /** A change to one Session: its next revision, sent to the window while it holds the Session. */
  const change = (session: Session, state: Partial<SessionState>, what: Partial<LiveBatch>, fins?: FinAsks) => {
    const revision = (host.revision[session] += 1)
    host.history[session].set(revision, { ...now(session), ...(revision > 1 && host.history[session].get(revision - 1)), ...state })
    if (session === "newest") host.finsAt.set(revision, fins ?? host.finsAt.get(revision - 1)!)
    if (held(session)) applyLiveBatch({ id: keys[session], revision, epoch: "E", updates: [], ...what })
  }
  const listRemote = (initial = false) => {
    const ask = host.remote
    const summary: LiveSummary = { session: { id: remote, harness: "codex", cwd: "/elsewhere", title: "Elsewhere", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }, revision: counter, createdAt: 3, elsewhere: "another Mac", ...(ask && { waitingOn: `Wait ${ask.id}`, attention: { kind: ask.kind, key: ask.id } }) }
    if (initial) listLive([summary])
    else hydrateLiveSummaries([summary], true)
  }
  /** Reads of a Session out now (the window's own, recovering, or the run's), answered as of when they were asked. */
  const reads: { session: Session; revision: number; answer: (snapshot: LiveSnapshot) => void }[] = []
  readSnapshot = (id) => new Promise((answer) => {
    const session = SESSIONS.find((each) => keys[each] === id)!
    reads.push({ session, revision: host.revision[session], answer })
  })
  const settle = async () => {
    for (let wait = 0; wait < 6; wait += 1) await turn()
  }
  const trail: string[] = []

  /** The newest revision the window has taken of each Session, held now or not: it never goes back past it. */
  const newestTaken: BySession<number> = { older: 1, newest: 1 }
  const check = (what: string) => {
    for (const session of SESSIONS) {
      const revision = heldRevision(session)
      if (revision === undefined) continue
      assert.ok(revision >= newestTaken[session], `seed ${seed}, after ${what}: the window took the ${session} Session back from ${newestTaken[session]} to ${revision}, answered asks with it\n${trail.slice(-16).join("\n")}`)
      newestTaken[session] = revision
    }
    const shown = notificationsStore.get().items.filter((item) => ["approval", "question", "needs-you"].includes(item.kind))
    const open = new Set<string>()
    const unknown = new Set<string>()
    for (const session of SESSIONS) {
      const revision = heldRevision(session)
      if (revision === undefined) {
        unknown.add(subjects[session])
        continue
      }
      const state = host.history[session].get(revision)!
      if (state.own) open.add(`${subjects[session]}:${state.own.kind}:${state.own.id}`)
      // A sign-out waits behind its own approval or question, and is said once that's answered.
      if (state.signIn && !state.own) open.add(`${subjects[session]}:needs-you:sign-in:${state.signIn}`)
    }
    const finsKnown = heldRevision("newest") !== undefined
    const fins = finsKnown ? host.finsAt.get(heldRevision("newest")!)! : {}
    if (host.remote) open.add(`${subjects.remote}:${host.remote.kind}:${host.remote.id}`)
    if (host.outside !== undefined) open.add(`${subjects.outside}:needs-you:external:${host.outside}`)
    const where = () => `seed ${seed}, after ${what}:\n${trail.slice(-16).join("\n")}\nshown ${JSON.stringify(shown.map((item) => `${item.id}${item.seen ? " (seen)" : ""}`))}`
    for (const ask of open) assert.ok(shown.some((item) => item.id === ask), `${where()}\nan open ask has no notice: ${ask}`)
    for (const fin of FINS) {
      const ask = fins[fin]
      if (ask) assert.ok(shown.some((item) => item.id.endsWith(`:${ask.kind}:fin:${finIds[fin]}:${ask.id}`)), `${where()}\nFin ${fin}'s open ${ask.id} has no notice`)
    }
    for (const item of shown) {
      if (item.seen) continue
      const fin = item.id.includes(":fin:")
      if (fin) {
        if (!finsKnown) continue
        assert.ok(FINS.some((each) => fins[each] && item.id.endsWith(`:${fins[each]!.kind}:fin:${finIds[each]}:${fins[each]!.id}`)), `${where()}\na notice stands for a Fin's ask that isn't open: ${item.id}`)
      } else if (!unknown.has(item.subject.id)) assert.ok(open.has(item.id), `${where()}\na notice stands for an ask that isn't open: ${item.id}`)
    }
    if (open.size + FINS.filter((fin) => fins[fin]).length > 1) counts.several += 1
  }

  notificationsStore.set({ items: [] })
  acpStore.set({ activeKey: null, conversations: {} })
  visible = new Set()
  applyThreadGroupChange({ thread, group: { id: thread, sessions: [ids.older, ids.newest].map((id) => ({ id, origin: "started" as const, started: true })) } })
  for (const session of SESSIONS) {
    applyLiveSnapshot(snapshot(session))
    unloadLive(session === "older" ? keys.older : keys.newest)
  }
  acpStore.set({ activeKey: null })
  listRemote(true)
  for (let step = 0; step < steps; step += 1) {
    const roll = pick()
    const session = choose(SESSIONS)
    if (roll < 0.3) {
      // An ask opens, or one replaces another: a Session's own, a sign-out, a Fin's, the remote Session's, the outside app's.
      const source = choose(["own", "own", "sign-in", "fin", "fin", "remote", "outside"] as const)
      const ask: Ask = { id: next("q"), kind: choose(["approval", "question"] as const) }
      if (source === "own") {
        if (now(session).own) counts.replaced += 1
        else counts.asked += 1
        trail.push(`the ${session} Session asks ${ask.kind} ${ask.id}`)
        const state = { ...now(session), own: ask }
        change(session, { own: ask }, { permissions: permissions(state) })
      } else if (source === "sign-in") {
        if (now(session).signIn) continue
        counts.asked += 1
        const at = counter += 1
        trail.push(`the ${session} Session is signed out at ${at}`)
        change(session, { signIn: at }, { requests: requests({ ...now(session), signIn: at }) })
      } else if (source === "fin") {
        const fin = choose(FINS)
        if (host.fins[fin]) counts.replaced += 1
        else counts.asked += 1
        host.fins = { ...host.fins, [fin]: ask }
        trail.push(`Fin ${fin} asks ${ask.kind} ${ask.id}`)
        change("newest", {}, { nativeAgents: roster(host.fins) }, host.fins)
      } else if (source === "remote") {
        if (host.remote) counts.replaced += 1
        else counts.asked += 1
        host.remote = ask
        trail.push(`the remote Session asks ${ask.kind} ${ask.id}`)
        listRemote()
      } else {
        if (host.outside !== undefined) continue
        counts.asked += 1
        host.outside = counter += 1
        trail.push(`the outside app asks at ${host.outside}`)
        applyThreadActivity(outside, { provider: "claude", since: host.outside, status: "needs-input", detail: "Allow?" })
      }
    } else if (roll < 0.55) {
      // An ask is answered.
      const source = choose(["own", "sign-in", "fin", "remote", "outside"] as const)
      if (source === "own" && now(session).own) {
        counts.answered += 1
        const own = now(session).own!
        // The person answers it in this window, half the time: the answer's receipt is read back late, as it lands.
        const here = held(session) && pick() < 0.5
        trail.push(`the ${session} Session's ${own.id} answered${here ? " in this window" : ""}`)
        change(session, { own: undefined }, { permissions: [] })
        if (here) {
          // SAFETY: the answer as the approval card sends it; this window's bridge takes any.
          const allow = { outcome: "selected", optionId: "allow" } as never
          void answerLiveApproval(keys[session], own.id, allow)
        }
      } else if (source === "sign-in" && now(session).signIn) {
        counts.answered += 1
        trail.push(`the ${session} Session is signed in again`)
        change(session, { signIn: undefined }, { requests: [] })
      } else if (source === "fin") {
        const fin = choose(FINS)
        if (!host.fins[fin]) continue
        counts.answered += 1
        trail.push(`Fin ${fin}'s ${host.fins[fin]!.id} answered`)
        host.fins = { ...host.fins, [fin]: undefined }
        change("newest", {}, { nativeAgents: roster(host.fins) }, host.fins)
      } else if (source === "remote" && host.remote) {
        counts.answered += 1
        trail.push(`the remote Session's ${host.remote.id} answered`)
        host.remote = undefined
        listRemote()
      } else if (source === "outside" && host.outside !== undefined) {
        counts.answered += 1
        trail.push("the outside app goes on")
        host.outside = undefined
        applyThreadActivity(outside, { provider: "claude", since: counter += 1, status: "active" })
      } else continue
    } else if (roll < 0.62) {
      counts.turns += 1
      const running = !now(session).running
      trail.push(`the ${session} Session ${running ? "starts" : "ends"} a turn`)
      change(session, { running }, { session: sessionOf(session, { ...now(session), running }) })
    } else if (roll < 0.7) {
      // The window reads a Session now (it opens it, or recovers it), answered later.
      trail.push(`the window reads the ${session} Session at ${host.revision[session]}`)
      void hydrateLive(keys[session])
    } else if (roll < 0.8) {
      // A read is answered, any of those out, as of when it was asked.
      const read = reads.splice(Math.floor(pick() * reads.length), 1)[0]
      if (!read) continue
      counts.lateReads += 1
      if (read.revision < (heldRevision(read.session) ?? 0)) counts.staleReads += 1
      trail.push(`the read of the ${read.session} Session at ${read.revision} is answered`)
      read.answer(snapshot(read.session, read.revision))
    } else if (roll < 0.86) {
      if (held(session) && acpStore.get().conversations[keys[session]]?.hydrated) {
        counts.letGo += 1
        acpStore.set({ activeKey: null })
        trail.push(`the window lets the ${session} Session go: ${String(unloadLive(keys[session]))}`)
      } else {
        counts.opened += 1
        trail.push(`the window opens the ${session} Session at ${host.revision[session]}`)
        applyLiveSnapshot(snapshot(session))
      }
    } else if (roll < 0.9) {
      if (!held(session)) {
        trail.push(`the window lists the ${session} Session again at ${host.revision[session]}`)
        applyLiveSnapshot(snapshot(session))
        unloadLive(keys[session])
      } else {
        counts.removed += 1
        trail.push(`the window loses the ${session} Session`)
        removeAcpConversation(keys[session])
      }
    } else {
      counts.looked += 1
      visible = new Set(Object.values(subjects).filter(() => pick() < 0.3))
      trail.push(`the person looks at ${[...visible].join(" ") || "nothing"}`)
      reconcileVisible()
    }
    await settle()
    check(trail.at(-1)!)
  }
  // Every read answered, and every Session held again as it stands: everything open has its notice, nothing more.
  for (let round = 0; reads.length && round < 50; round += 1) {
    const read = reads.shift()!
    read.answer(snapshot(read.session, read.revision))
    await settle()
  }
  for (const session of SESSIONS) if (!held(session)) applyLiveSnapshot(snapshot(session))
  await settle()
  check("the end")
  return counts
}

// Whatever brings a snapshot (a read, or an action's answer), one older than the revision this window holds of its
// conversation, shown or only listed after it was let go of, is past: taken, it would ask an answered question again.
{
  const thread = ThreadIdSchema.parse(randomUUID()), session = SessionIdSchema.parse(randomUUID()), key = "listed-past"
  const fin = childEntry(ThreadParentSchema.parse({ child: randomUUID(), parent: thread, parentSession: session, name: "fin", role: "worker", origin: "started", asked: { brief: { objective: "Work" }, harness: "claude" }, op: "start-fin", startedBy: { kind: "agent", session }, createdAt: 1 }), { source: "live" }, {})
  const asking = NativeAgentSchema.parse({ ...fin, child: { ...fin.child!, state: { kind: "blocked", question: "Which?", on: "person", ask: { kind: "question", id: "which", options: [{ label: "This" }] } } } })
  const at = (revision: number, agents: NativeAgent[]): LiveSnapshot => ({ session: { id: key, harness: "codex", cwd: "/fixture", title: "Listed", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }, threadId: thread, sessionId: session, epoch: "E", revision, createdAt: 1, blocks: [], requests: [], permissions: [], base: null, nativeAgents: { agents, limited: false } })
  visible = new Set()
  notificationsStore.set({ items: [] })
  applyLiveSnapshot(at(1, [asking]))
  unloadLive(key)
  applyLiveBatch({ id: key, revision: 2, epoch: "E", updates: [], nativeAgents: { agents: [fin], limited: false } })
  applyLiveSnapshot(at(1, [asking]))
  assert.equal(acpStore.get().conversations[key]?.revision, 2, "a listed Session takes no snapshot older than it")
  assert.equal(notificationsStore.get().items.filter((item) => !item.seen).length, 0, "and its answered question isn't asked again")
}

const only = process.env.SEED
const seeds = only ? [Number(only)] : Array.from({ length: Number(process.env.SEEDS ?? 300) }, (_, at) => at + 1)
const totals: Record<string, number> = {}
for (const seed of seeds) for (const [name, count] of Object.entries(await run(seed, 120))) totals[name] = (totals[name] ?? 0) + count
// The runs have to have tried what they're for.
if (!only) for (const [name, count] of Object.entries(totals)) assert.ok(count >= seeds.length / 10, `too few ${name}: ${JSON.stringify(totals)}`)
console.log(`Ask notices: over ${seeds.length} generated runs, every ask open had its notice and none the person hadn't seen stood for one answered, after every step (${Object.entries(totals).map(([name, count]) => `${count} ${name}`).join(", ")})`)
process.exit(0)

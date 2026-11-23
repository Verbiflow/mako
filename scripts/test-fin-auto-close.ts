import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { mock } from "node:test"
import { closedFinished, FINISHED_CLOSE, INTERNAL_RUN_CLOSE, type AgentCaller, type AgentRefused, type ChildState, type ThreadParent } from "@mako/host/contracts/agents"
import { SessionIdSchema, ThreadIdSchema, type ThreadId } from "@mako/host/contracts/thread-identity"
import type { PullReading } from "@mako/host/contracts/pull-waits"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { FINISHED_CLOSE_MS, FINISHED_SWEEP_JOB } from "@mako/host/conversations/agents"
import { ThreadStore } from "@mako/host/threads/store"
import { AgentsWorld, type ScriptedTurn, type WorldOptions } from "./lib/agents-world.ts"

/**
 * A finished Fin closes by itself, and closing never cuts it off (`npm run test:fin-close`).
 *
 * On 2026-11-17 the person's store held 113 open Fins, 98 of them done, 61 for over a week: nothing ever closed an edge
 * for being finished, so each rode every prompt's note, every list and every start. Now `Agents.closeFinished` closes
 * one six hours after its last report, when nothing is pending. Three things are held here.
 *
 * It closes, and only as bookkeeping: no prompt, no report, no stop, and it still reads as done.
 *
 * Nothing pending is ever closed: each thing a closed edge would hide or strand keeps its Fin open however long ago it
 * finished (a decision, a question, an action, a report or answer or pull request's outcome undelivered, a start that
 * waits on it, Fins of its own, a turn, a message queued or held, work its harness left running, an armed wait, a pull
 * request Mako watches), and so does being placed on another device.
 *
 * Every way to reach a closed Fin opens it again in the same Session with its history: its Apex's message (queued,
 * steered, interrupting), an answer to something asked since, the person in its own Thread, the person's `@` from the
 * Apex's composer, a pull request's outcome that comes late, a sibling's message its Apex passes on, and any of them
 * after a restart. Opened again it is an open Fin, and its six hours start over at its next report.
 *
 * Time passes on the one clock the engine, the journals and the store all read: `Date.now` is moved forward six hours
 * at a time, so nothing sleeps and every time kept anywhere agrees with the others.
 */
const root = mkdtempSync(join(tmpdir(), "mako-fin-close-"))
const AGE = FINISHED_CLOSE_MS + 60_000
const wallNow = Date.now.bind(Date)
/** How far the clock every part reads is ahead of the wall's. It only moves forward. */
const clock = { offset: 0 }
mock.method(Date, "now", () => wallNow() + clock.offset)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

function kept<T extends object>(value: T | AgentRefused): T {
  assert.ok(!("refused" in value), JSON.stringify(value))
  return value
}

interface Fixture {
  world: AgentsWorld
  apex: { conversation: string; caller: AgentCaller }
  clock: { offset: number }
  fin: string
  child: ThreadId
  edge(name?: string): ThreadParent
  state(name?: string): ChildState | undefined
  finPrompts(): string[]
  /** The digests the Apex's harness was sent. */
  wakes: string[]
  /** Starts another Fin of the same Apex. */
  start(name: string): Promise<{ conversation: string; child: ThreadId }>
  /** Brings the clock forward six hours and a minute, unless told not to, and sweeps; the names it closed. */
  sweep(advance?: boolean): Promise<string[]>
}

interface FixtureOptions {
  /** A Fin's turn, by its name and how many it has had; undefined answers as the default does. */
  finTurn?: (turn: ScriptedTurn, name: string, count: number) => Promise<string | undefined> | string | undefined
  apexTurn?: (turn: ScriptedTurn) => Promise<void> | void
  /** The worker's first turn holds: the fixture doesn't wait for it to end. */
  working?: true
  world?: Partial<WorldOptions>
}

/** An Apex with one Fin, "worker", that finished: its first turn's reply is its result. */
async function fixture(name: string, options: FixtureOptions = {}): Promise<Fixture> {
  const wakes: string[] = []
  const names = new Map<string, string>()
  const counts = new Map<string, number>()
  const world = new AgentsWorld({
    root: join(root, name),
    finLimit: () => 8,
    script: async (turn) => {
      const brief = /You're fin:(\S+?),/.exec(turn.text)?.[1]
      if (brief) names.set(turn.conversation, brief)
      const fin = names.get(turn.conversation)
      if (!fin) {
        if (turn.text.startsWith(FROM_AGENTS)) wakes.push(turn.text)
        await options.apexTurn?.(turn)
        return "ok"
      }
      const count = (counts.get(fin) ?? 0) + 1
      counts.set(fin, count)
      return (await options.finTurn?.(turn, fin, count)) ?? (count === 1 ? `${fin} finished.` : `${fin} did: ${turn.text.split("\n").at(-1)}`)
    },
    ...options.world,
  })
  const apex = await world.apex("codex", "full")
  const start = async (fin: string) => {
    const started = kept(await world.agents.start(apex.caller, { brief: { objective: `Do the ${fin} work` }, harness: "claude", name: fin, clientKey: fin, cwd: world.root }))
    assert.ok(started.conversation && started.child, JSON.stringify(started))
    return { conversation: started.conversation, child: ThreadIdSchema.parse(started.child) }
  }
  const worker = await start("worker")
  if (!options.working) await world.settle(400)
  const edge = (fin = "worker") => {
    const found = world.store.edges().all.find((each) => each.name === fin)
    assert.ok(found, `no edge for ${fin}`)
    return found
  }
  return {
    world, apex, clock, fin: worker.conversation, child: worker.child, edge, wakes, start,
    state: (fin = "worker") => world.agents.roster(apex.conversation).find((each) => each.child?.name === fin)?.child?.state,
    finPrompts: () => world.prompts.filter((prompt) => prompt.conversation === worker.conversation).map((prompt) => prompt.text),
    sweep: async (advance = true) => {
      if (advance) clock.offset += AGE
      const closed = await world.agents.closeFinished()
      return closed.map((child) => world.store.edges().of(child)?.name ?? child)
    },
  }
}

/** A Fin that would have closed but for one thing: the sweep, however late, leaves its edge open. */
async function staysOpen(what: string, f: Fixture, name = "worker"): Promise<void> {
  const closed = await f.sweep()
  assert.ok(!closed.includes(name), `${what}: the sweep closed ${name}`)
  assert.equal(f.edge(name).closedAt, undefined, `${what}: its edge stays open`)
  // A second pass, a day on, changes nothing either.
  f.clock.offset += 24 * 60 * 60_000
  assert.ok(!(await f.sweep(false)).includes(name), `${what}: nor a day later`)
  console.log(`kept open: ${what}`)
}

try {
  // It closes six hours after it finished, as bookkeeping alone, and still reads as done.
  {
    const f = await fixture("closes")
    assert.deepEqual(f.state(), { kind: "ended", outcome: "done" })
    const door = () => f.world.agents.frontDoor(f.apex.conversation, {}).join("\n")
    assert.match(door(), /fin:worker/, "an open Fin is in its Apex's note")
    f.clock.offset += FINISHED_CLOSE_MS - 60_000
    assert.deepEqual(await f.sweep(false), [], "a minute short of six hours it stays open")
    assert.equal(f.world.jobs.list().find((job) => job.name === FINISHED_SWEEP_JOB)?.paused, false, "the sweep comes back while an open Fin has finished")
    const before = { prompts: f.world.prompts.length, starts: f.world.starts.length, reports: f.world.store.reportsOf(f.child, 0).length, wakes: f.wakes.length, session: f.world.live.session(f.fin) }
    f.clock.offset += 120_000
    assert.deepEqual(await f.sweep(false), ["worker"], "six hours after its last report it closes")
    const edge = f.edge()
    assert.ok(edge.closedAt !== undefined && closedFinished(edge))
    assert.equal(edge.closedReason, FINISHED_CLOSE, "with its own reason, which an older build shows as any stop's")
    assert.deepEqual(f.state(), { kind: "ended", outcome: "done" }, "it reads as done, not stopped")
    await f.world.settle(400)
    assert.deepEqual({ prompts: f.world.prompts.length, starts: f.world.starts.length, reports: f.world.store.reportsOf(f.child, 0).length, wakes: f.wakes.length, session: f.world.live.session(f.fin) }, before, "closing sends nothing, reports nothing, wakes no one and stops no process")
    assert.doesNotMatch(door(), /fin:worker/, "its Apex's note no longer names it")
    assert.equal(f.world.agents.personAsk(f.apex.conversation), undefined)
    const listed = kept(await f.world.agents.list(f.apex.caller, {}))
    assert.ok("children" in listed)
    assert.deepEqual(listed.children, [], "nor does its list")
    assert.equal(listed.folded?.ended, 1, "which counts it")
    const all = kept(await f.world.agents.list(f.apex.caller, { scope: "all" }))
    assert.ok("children" in all)
    assert.deepEqual(all.children.map((strip) => [strip.name, strip.state]), [["worker", { kind: "ended", outcome: "done" }]], "scope all still lists it, done")
    assert.deepEqual(await f.sweep(false), [], "a second pass closes nothing more")
    assert.equal(f.world.jobs.list().find((job) => job.name === FINISHED_SWEEP_JOB)?.paused, true, "and with no open Fin finished the sweep holds no timer")
    // A stop of it is still a stop, in its own words.
    const stopped = kept(await f.world.agents.stop(f.apex.caller, { child: "worker", reason: "not needed again" }))
    assert.deepEqual(stopped.stopped, ["worker"])
    assert.deepEqual(f.state(), { kind: "ended", outcome: "stopped", reason: "not needed again" })
    await f.world.close()
  }
  console.log("closes: six hours after its report, with nothing sent, reported, woken or stopped; it reads as done and leaves the note and the list")

  // A failed Fin that asks nothing closes the same way; one a stop closed keeps its stop.
  {
    const f = await fixture("failed", { finTurn: async (turn, name, count) => {
      if (count !== 1) return undefined
      await turn.world.agents.report(turn.caller, { status: "failed", summary: `The ${name} build never linked.`, clientKey: "failed" })
      return "Failed."
    } })
    const stoppedFin = await f.start("halted")
    await f.world.settle(400)
    kept(await f.world.agents.stop(f.apex.caller, { child: "halted", reason: "wrong approach" }))
    assert.deepEqual(await f.sweep(), ["worker"])
    assert.deepEqual(f.state(), { kind: "ended", outcome: "failed", reason: "The worker build never linked." }, "a failed Fin closed as finished still reads as failed")
    assert.equal(f.edge("halted").closedReason, "wrong approach", "a stopped Fin's close is its stop's")
    assert.equal(f.world.store.edges().of(stoppedFin.child)?.closedAt !== undefined, true)
    await f.world.close()
  }
  console.log("failed: closed as finished and still failed; a stop's close is left alone")

  // ── Nothing pending is ever closed ──

  // A decision its Apex makes, and one the person makes.
  for (const decides of ["apex", "person"] as const) {
    const timers: (() => void)[] = []
    const f = await fixture(`decision-${decides}`, {
      world: { later: (_ms, run) => (timers.push(run), () => {}) },
      finTurn: async (turn, _name, count) => {
        if (count !== 1) return undefined
        await turn.world.agents.report(turn.caller, { status: "done", summary: "PR #7 is green.", question: "Merge #7?", options: [{ label: "Merge" }, { label: "Leave" }], decides, clientKey: "decide" })
        return "Reported."
      },
    })
    const state = f.state()
    assert.ok(state?.kind === "ended" && state.decision?.on === (decides === "apex" ? "lead" : "person"))
    await staysOpen(`a decision that is ${decides === "apex" ? "its Apex's" : "the person's"}`, f)
    assert.equal(f.world.store.openReportAsks(f.child).length, 1, "and its question is still open")
    await f.world.close()
  }

  // A question it waits on (not finished at all), and a failure that asks.
  {
    const f = await fixture("question", { world: { later: () => () => {} }, finTurn: async (turn, _name, count) => {
      if (count !== 1) return undefined
      await turn.world.agents.report(turn.caller, { status: "needs-input", summary: "Two schemas fit.", question: "Which schema?", clientKey: "ask" })
      return "Asked."
    } })
    await staysOpen("a question it waits on", f)
    await f.world.close()
  }
  {
    const f = await fixture("failed-asking")
    const generation = f.world.store.latestReports().get(f.child)!.ownerGeneration
    // As an older build could leave it: a failure with a question, which no surface answers by an ask.
    f.world.store.keepReport({ id: `report:${f.child}:failed-asking`, child: f.child, status: "failed", summary: "It could not push.", question: "Push by hand?", implicit: true, ownerGeneration: generation, at: Date.now() })
    f.world.store.markReportsDelivered([`report:${f.child}:failed-asking`], Date.now())
    await staysOpen("a failure that asks something", f)
    await f.world.close()
  }

  // An action only its Apex disposes of.
  {
    const f = await fixture("action", { finTurn: async (turn, _name, count) => {
      if (count !== 1) return undefined
      kept(await turn.world.agents.report(turn.caller, { status: "done", summary: "Ready for review.", action: "Dispatch a review of the branch.", followUp: { ref: "fixture:review/1", version: "head-1" }, clientKey: "ready" }))
      return "Reported."
    } })
    assert.equal(f.world.store.pendingActionThreads().has(f.child), true)
    await staysOpen("a pending action it reported", f)
    await f.world.close()
  }

  // A report nobody has heard, an answer kept and not delivered, a pull request's outcome claimed and not delivered.
  {
    const f = await fixture("unheard-report")
    const generation = f.world.store.latestReports().get(f.child)!.ownerGeneration
    f.world.store.keepReport({ id: `report:${f.child}:unheard`, child: f.child, status: "done", summary: "Kept as the host died.", ownerGeneration: generation, at: Date.now() })
    assert.equal(f.world.store.undeliveredReports().length, 1)
    await staysOpen("a report its Apex hasn't heard", f)
    await f.world.close()
  }
  {
    const f = await fixture("unheard-answer")
    const report = f.world.store.latestReports().get(f.child)!
    f.world.store.claimAnswer({ ask: report.id, child: f.child, op: "answer:test", by: "person", answer: "Yes", request: randomUUID(), text: "Yes", at: Date.now() })
    assert.equal(f.world.store.undeliveredAnswers().length, 1)
    await staysOpen("an answer kept and not delivered", f)
    await f.world.close()
  }
  {
    const f = await fixture("unheard-pull")
    const report = f.world.store.latestReports().get(f.child)!
    f.world.store.claimPullWake({ wait: `pull-wake:${f.child}:${report.id}:acme/app#7`, child: f.child, report: report.id, pull: "acme/app#7", outcome: "merged", request: randomUUID(), text: "Mako: PR acme/app#7 merged.", at: Date.now() })
    assert.equal(f.world.store.undeliveredPullWakes().length, 1)
    await staysOpen("a pull request's outcome claimed and not delivered", f)
    await f.world.close()
  }

  // Its result held in its Apex's queue for a Fin still at work (`HOLD_RESULTS_MS`, lengthened here past the sweep's
  // six hours and the day after): its Apex hasn't taken it, so it stays open, and closes once the digest went.
  {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const f = await fixture("held-digest", {
      finTurn: async (_turn, name, count) => {
        if (name === "busy" && count === 1) await held
        return undefined
      },
      world: { holdMs: 3 * 24 * 60 * 60_000 },
    })
    await f.start("busy")
    const late = await f.start("late")
    const waits = () => f.world.live.held(f.apex.conversation)?.requests.find((request) => (request.status === "queued" || request.status === "held") && request.digest?.notices.some((notice) => notice.report.child === late.child))
    await until("the late Fin's result to be held in its Apex's queue", () => waits()?.wake?.since !== undefined)
    assert.equal(waits()!.status, "held")
    await staysOpen("a result held for the Fins still at work", f, "late")
    assert.equal(f.world.agents.keptOpenBy(late.child), "its Apex hasn't taken its result")
    assert.deepEqual(f.state("late"), { kind: "ended", outcome: "done" }, "it reads as done meanwhile")
    release()
    await f.world.settle(400)
    await f.sweep(false)
    assert.ok(closedFinished(f.edge("late")), `taken, it closes: ${f.world.agents.keptOpenBy(late.child)}`)
    await f.world.close()
  }

  // Its result in a digest its Apex hasn't taken: the Apex is mid-turn on a harness that hears it at its turn's end.
  {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let holding = false
    const f = await fixture("unsent-digest", { apexTurn: async (turn) => {
      if (!turn.text.includes("Hold")) return
      holding = true
      await held
    } })
    const late = await (async () => {
      f.world.say(f.apex.conversation, "Hold")
      await until("the Apex's turn", () => holding)
      return f.start("late")
    })()
    await until("the late Fin's result to wait in its Apex's queue", () => f.world.live.held(f.apex.conversation)?.requests.some((request) => request.status === "queued" && request.digest?.notices.some((notice) => notice.report.child === late.child)) === true)
    await staysOpen("a result its Apex hasn't taken", f, "late")
    release()
    await f.world.settle(400)
    // The pass a settling turn starts may have closed it already; this one closes it otherwise.
    await f.sweep(false)
    assert.ok(closedFinished(f.edge("late")), `taken, it closes: ${f.world.agents.keptOpenBy(late.child)}`)
    await f.world.close()
  }

  // A queued start that goes after it: one that ended without a result is still waited on, and stays open for it.
  {
    const f = await fixture("after", { working: true, finTurn: async (turn, name, count) => {
      if (name !== "worker" || count !== 1) return undefined
      await turn.world.agents.report(turn.caller, { status: "progress", summary: "Halfway through.", clientKey: "half" })
      await turn.world.hold(turn.conversation)
      return "Still going."
    } })
    await until("the worker at work", () => f.state()?.kind === "working")
    const queued = kept(await f.world.agents.start(f.apex.caller, { brief: { objective: "Follow the worker" }, harness: "claude", name: "next", clientKey: "next", cwd: f.world.root, after: ["worker"] }))
    assert.equal(queued.state, "queued", JSON.stringify(queued))
    f.world.release(f.fin)
    await until("the worker to end without a result", () => { const now = f.state(); return now?.kind === "ended" && now.outcome === "failed" && now.unfinished === true })
    await f.world.settle(400)
    await staysOpen("a queued start that goes after it", f)
    await f.world.close()
  }

  // Fins of its own that are open, working or finished: it closes only once they have.
  {
    let sub: { conversation: string; child: string } | undefined
    const f = await fixture("own-fins", { finTurn: async (turn, name, count) => {
      if (name !== "worker" || count !== 1) return undefined
      const started = kept(await turn.world.agents.start(turn.caller, { brief: { objective: "Do a part" }, harness: "claude", name: "part", clientKey: "part", cwd: turn.world.root }))
      sub = { conversation: started.conversation!, child: started.child! }
      return "Worker finished with its part."
    } })
    await until("the worker's result, after its part's", () => f.state()?.kind === "ended" && f.state("worker")?.kind === "ended" && f.world.store.edges().all.some((edge) => edge.name === "part"))
    await f.world.settle(600)
    assert.ok(sub)
    assert.deepEqual(f.state(), { kind: "ended", outcome: "done" })
    assert.deepEqual(await f.sweep(), ["part"], "its own Fin closes first, and holds it open that pass")
    assert.equal(f.edge().closedAt, undefined)
    // The check-in Mako armed for it while its part worked is a wait of its own: armed, it holds its edge open too.
    const shiver = f.world.store.armedTurnWaitOf(f.fin)
    assert.equal(shiver?.armedBy, "mako")
    assert.deepEqual(await f.sweep(false), [], "an armed check-in keeps it open")
    assert.equal(f.world.agents.stopWaiting(f.fin, shiver.id), true)
    assert.deepEqual(await f.sweep(false), ["worker"], `then it closes: ${f.world.agents.keptOpenBy(f.child)}`)
    // The person writing to the part opens it, and the Fin above it with it: no open Fin stands under a closed one.
    f.world.say(sub.conversation, "One more part.")
    await until("the part to open again", () => f.edge("part").closedAt === undefined)
    assert.equal(f.edge().closedAt, undefined, "its Apex, a Fin too, is open again with it")
    await f.world.settle(600)
    await f.world.close()
  }
  console.log("kept open: Fins of its own, bottom up; opening one opens the Fin above it")

  // A turn running after its done report; then a message held in its queue, read in from its journal by the next host.
  {
    const f = await fixture("turn", { working: true, finTurn: async (turn, _name, count) => {
      if (count !== 1) return undefined
      await turn.world.agents.report(turn.caller, { status: "done", summary: "Done, tidying up.", clientKey: "done" })
      await turn.world.hold(turn.conversation)
      return "Tidied."
    } })
    await until("its done report, its turn still running", () => f.world.store.latestReports().get(f.child)?.status === "done")
    assert.equal(f.world.live.atWork(f.fin), true)
    await staysOpen("a turn still running after its done report", f)
    f.world.release(f.fin)
    await f.world.settle(400)
    await f.world.close()
  }
  {
    const f = await fixture("held-message")
    f.world.live.submit(f.fin, randomUUID(), "Look at this when you resume.", [], undefined, undefined, undefined, undefined, { pause: "stop" })
    assert.equal(f.world.live.held(f.fin)?.requests.at(-1)?.status, "held")
    await staysOpen("a message held in its queue", f)
    await f.world.restart()
    assert.equal(f.edge().closedAt, undefined)
    assert.ok(!(await f.sweep(false)).includes("worker"), "nor by the next host, which reads its journal to see it")
    await f.world.close()
  }
  console.log("kept open: a message held in its queue, across a restart")

  // An armed wait in its conversation.
  {
    const f = await fixture("armed-wait")
    const armed = await f.world.agents.turnWait(f.world.caller(f.fin), { description: "Checking the deploy tomorrow", seconds: 30 * 60 * 60, clientKey: "tomorrow" })
    assert.ok(!("refused" in armed), JSON.stringify(armed))
    await staysOpen("an armed wait of its own", f)
    await f.world.close()
  }

  // A pull request its last report waits on, watched or not.
  for (const watched of [true, false]) {
    const f = await fixture(`pull-${watched}`, {
      world: watched ? { readPull: async () => null } : {},
      finTurn: async (turn, _name, count) => {
        if (count !== 1) return undefined
        await turn.world.agents.report(turn.caller, { status: "done", summary: "Opened #7.", waitingOn: [{ kind: "pull-request", ref: "https://git.example.com/acme/app/pull/7", until: "merge" }], clientKey: "pr" })
        return "Reported."
      },
    })
    await staysOpen(`a pull request its report waits on${watched ? "" : ", on a host with no reader"}`, f)
    await f.world.close()
  }

  // Placed on another device, either end: what waits there isn't this host's to know.
  {
    const f = await fixture("placed")
    const edge = f.edge()
    const db = new DatabaseSync(join(f.world.root, "threads.sqlite"))
    const placed: ThreadParent = { ...edge, remote: { device: randomUUID(), access: "auto" } }
    db.prepare("UPDATE thread_parents SET record = ? WHERE child_thread = ?").run(JSON.stringify(placed), edge.child)
    db.close()
    assert.ok(f.edge().remote, "its edge names an Apex on another device")
    await staysOpen("a Fin whose Apex is on another device", f)
    await f.world.close()
  }

  // ── Every way to reach a closed Fin opens it in the same Session ──
  {
    const relayed: string[] = []
    const f = await fixture("reopen", {
      finTurn: async (turn, name, count) => {
        if (name === "mate" && turn.text.includes("tell the worker")) {
          const sent = await turn.world.agents.send(turn.caller, { to: "worker", text: "Use the v2 schema.", clientKey: "relay" })
          assert.ok("refused" in sent && sent.refused === "relayed", JSON.stringify(sent))
          return "Told my Apex."
        }
        if (name === "worker" && count > 1 && turn.text.includes("ask again")) {
          await turn.world.agents.report(turn.caller, { status: "done", summary: "Both would work.", question: "Ship the small one?", clientKey: `ask-${count}` })
          return "Asked."
        }
        return undefined
      },
      apexTurn: async (turn) => {
        if (!turn.text.includes("hands work to another")) return
        relayed.push(turn.text)
        kept(await turn.world.agents.send(turn.caller, { to: "worker", text: "Your mate says: use the v2 schema.", clientKey: "pass-on" }))
      },
      world: { later: () => () => {} },
    })
    const native = f.world.live.session(f.fin)?.nativeId
    assert.equal(native, `native-${f.fin}`)
    assert.deepEqual(await f.sweep(), ["worker"])
    let turns = 1
    /** After each way in: it took the message in the same Session, is open, reported and woke its Apex; then it closes again six hours on. */
    const reopened = async (how: string, words: string, by: "apex" | "person" | "mako") => {
      turns += 1
      await until(`${how}: its turn`, () => f.finPrompts().length === turns)
      await until(`${how}: its result`, () => f.state()?.kind === "ended" && f.world.store.reportsOf(f.child, 0).length >= turns)
      const prompt = f.finPrompts().at(-1)!
      assert.ok(prompt.includes(words), `${how}: its harness was sent the words: ${prompt}`)
      assert.doesNotMatch(prompt, /resumed after a stop/, `${how}: it wasn't stopped, and isn't told it was`)
      assert.equal(f.world.live.session(f.fin)?.nativeId, native, `${how}: the same harness session`)
      assert.equal(f.world.agents.roster(f.apex.conversation).find((each) => each.child?.name === "worker")?.child?.conversation, f.fin, `${how}: the same conversation`)
      assert.ok(f.finPrompts().length === turns && f.world.live.snapshot(f.fin)!.requests.filter((request) => request.status === "completed").length === turns, `${how}: its history is whole`)
      const edge = f.edge()
      assert.equal(edge.closedAt, undefined, `${how}: its edge is open`)
      assert.equal(edge.resumed?.reason, FINISHED_CLOSE, `${how}: and says what it was opened from`)
      const wakes = f.wakes.length
      await f.world.settle(600)
      if (by !== "mako") assert.ok(f.wakes.length >= wakes && f.wakes.some((wake) => wake.includes(`worker did: ${words}`) || wake.includes("worker")), `${how}: its Apex hears its turn`)
      assert.ok(!(await f.sweep(false)).includes("worker"), `${how}: open again, it isn't closed before six hours from its new report`)
      assert.ok((await f.sweep()).includes("worker"), `${how}: and closes again six hours after it`)
      assert.ok(closedFinished(f.edge()))
      console.log(`reopened: ${how}`)
    }
    for (const deliver of ["queue", "steer", "interrupt"] as const) {
      const sent = kept(await f.world.agents.send(f.apex.caller, { to: "worker", text: `Go on (${deliver}).`, deliver, clientKey: `go-${deliver}` }))
      assert.equal(sent.delivery, "turn", `${deliver}: an idle Fin takes it as its next turn`)
      await reopened(`agents_send, ${deliver}`, `Go on (${deliver}).`, "apex")
    }
    // The person in its own Thread.
    f.world.say(f.fin, "Also update the notes.")
    await reopened("the person in its own Thread", "Also update the notes.", "person")
    // The person's `@` from its Apex's composer.
    const direct = kept(await f.world.agents.direct(f.apex.conversation, { to: "worker", request: randomUUID(), text: "And the changelog." }))
    assert.equal(direct.fin, f.child)
    await reopened("the person's @ from its Apex's composer", "And the changelog.", "person")
    // A sibling's message, relayed by the Apex.
    const mate = await f.start("mate")
    await f.world.settle(400)
    kept(await f.world.agents.send(f.apex.caller, { to: "mate", text: "tell the worker which schema", clientKey: "mate" }))
    await until("the Apex to pass the sibling's words on", () => relayed.length === 1)
    assert.match(relayed[0]!, /"mate" \(Claude\) → worker/)
    await reopened("a sibling's message its Apex passed on", "Your mate says: use the v2 schema.", "apex")
    assert.ok(mate.child)
    // An answer, once something asks again: asked since it closed, its question is as open as any.
    kept(await f.world.agents.send(f.apex.caller, { to: "worker", text: "ask again", clientKey: "re-ask" }))
    turns += 1
    await until("its question", () => { const now = f.state(); return now?.kind === "ended" && now.decision !== undefined })
    assert.ok(!(await f.sweep()).includes("worker"), "asking, it stays open")
    const ask = f.world.store.openReportAsks(f.child)[0]!
    // As a host from before this rule could leave it: closed with the question open.
    f.world.store.keepEdge({ ...f.edge(), closedAt: Date.now(), closedReason: FINISHED_CLOSE })
    assert.ok(closedFinished(f.edge()))
    const listed = kept(await f.world.agents.read(f.apex.caller, { child: "worker" }))
    assert.ok(listed.state.kind === "ended" && listed.state.decision?.question === "Ship the small one?", "a question on a Fin closed as finished is not hidden")
    const answered = kept(await f.world.agents.answer(f.apex.caller, { to: "worker", ask: ask.id, answer: "Yes, the small one.", clientKey: "answer" }))
    assert.equal(answered.answered, "report")
    await reopened("agents_answer to what it asked", "Answer: Yes, the small one.", "apex")
    // After a restart, read from the store alone: still closed, and a message still opens it.
    await f.world.restart()
    assert.ok(closedFinished(f.edge()))
    assert.deepEqual(f.state(), { kind: "ended", outcome: "done" })
    kept(await f.world.agents.send(f.world.caller(f.apex.conversation), { to: "worker", text: "After the restart.", clientKey: "restarted" }))
    await until("its turn after the restart", () => f.finPrompts().some((prompt) => prompt.includes("After the restart.")))
    await until("its result after the restart", () => f.state()?.kind === "ended" && f.edge().closedAt === undefined)
    assert.equal(f.world.live.session(f.fin)?.nativeId, native, "the same harness session after the restart")
    console.log("reopened: agents_send after a restart")
    await f.world.close()
  }

  // A pull request's outcome that comes late: claimed for a Fin closed meanwhile, it is delivered and opens it.
  {
    let pull: PullReading | null = null
    const f = await fixture("late-pull", {
      world: { readPull: async () => pull },
      finTurn: async (turn, _name, count) => {
        if (count !== 1) return undefined
        await turn.world.agents.report(turn.caller, { status: "done", summary: "Opened #7.", waitingOn: [{ kind: "pull-request", ref: "https://git.example.com/acme/app/pull/7", until: "merge" }], clientKey: "pr" })
        return "Reported."
      },
    })
    assert.deepEqual(f.world.agents.pulls.keys(), ["acme/app#7"])
    assert.deepEqual(await f.sweep(), [], "watched, it stays open")
    // As a host from before this rule, or a close that crossed the read, leaves it: closed with its wait standing.
    f.world.store.keepEdge({ ...f.edge(), closedAt: Date.now(), closedReason: FINISHED_CLOSE })
    assert.ok(closedFinished(f.edge()))
    assert.deepEqual(f.world.agents.pulls.keys(), ["acme/app#7"], "closed as finished, its wait is still watched")
    pull = { state: "merged", url: "https://git.example.com/acme/app/pull/7", author: "fin-bot", checks: [], reviews: [] }
    await f.world.agents.pulls.tick()
    await until("the outcome to reach it", () => f.finPrompts().some((prompt) => prompt.includes("Mako: PR acme/app#7")))
    await until("its turn on it", () => f.state()?.kind === "ended" && f.edge().closedAt === undefined)
    assert.equal(f.world.live.session(f.fin)?.nativeId, `native-${f.fin}`, "in the same Session")
    assert.equal(f.edge().resumed?.reason, FINISHED_CLOSE)
    assert.equal(f.world.store.undeliveredPullWakes().length, 0, "claimed once and delivered")
    await f.world.close()
  }
  console.log("reopened: a pull request's outcome that came late")

  // ── A harness's own reviewer runs ──
  {
    const dir = join(root, "internal")
    const f = await fixture("internal")
    const session = SessionIdSchema.parse(f.world.store.journalPlacement(f.apex.conversation)!.session)
    const placed = f.world.store.place({ harness: "codex", nativeId: "review-1", path: join(dir, "review-1.jsonl") }, { kind: "service", name: "catalog" })
    const review: ThreadParent = {
      child: ThreadIdSchema.parse(placed.thread), parent: f.edge().parent, parentSession: session, name: "review-1", role: "worker", origin: "discovered",
      asked: { brief: { objective: "Review" } }, op: "discovered:review-1", startedBy: { kind: "agent", session }, createdAt: Date.now(),
      run: { harness: "codex", nativeId: "review-1", device: f.world.store.deviceId, startedAt: Date.now(), nativeAgent: { kind: "unknown", role: "unclassified" } },
    }
    const open = f.world.store.keepEdge(review)
    assert.equal(open.closedAt, undefined, "an unclassified discovery is an open delegation")
    const classified = f.world.store.keepEdge({ ...open, run: { ...open.run!, nativeAgent: { kind: "internal-review", role: "guardian", source: "guardian_review" } } })
    assert.ok(classified.closedAt !== undefined, "known for a reviewer run, its edge closes in the same write")
    assert.equal(classified.closedReason, INTERNAL_RUN_CLOSE)
    assert.equal(f.world.store.edges().internalRuns.length, 1)
    assert.equal(f.world.store.edges().of(review.child), undefined, "and it is no Fin")
    // One a build from before the rule left open closes as the store next opens.
    await f.world.close()
    const path = join(f.world.root, "threads.sqlite")
    const db = new DatabaseSync(path)
    const { closedAt: _at, closedReason: _why, ...reopened } = classified
    db.prepare("UPDATE thread_parents SET record = ?, closed_at = NULL WHERE child_thread = ?").run(JSON.stringify(reopened), review.child)
    const formatBefore = db.prepare("SELECT key, value FROM store_meta WHERE key IN ('schema', 'reads') ORDER BY key").all()
    db.close()
    const next = new ThreadStore(path)
    const migrated = next.edges().internalRuns[0]
    assert.ok(migrated?.closedAt !== undefined && migrated.closedReason === INTERNAL_RUN_CLOSE, "the next open closes it")
    next.close()
    const after = new DatabaseSync(path)
    assert.deepEqual(after.prepare("SELECT key, value FROM store_meta WHERE key IN ('schema', 'reads') ORDER BY key").all(), formatBefore, "and the store's format numbers don't move: an older build still writes it")
    assert.equal(after.prepare("SELECT closed_at IS NOT NULL AS closed FROM thread_parents WHERE child_thread = ?").get(review.child)?.closed, 1)
    after.close()
  }
  console.log("internal reviewer runs: closed as they're classified, and at the next open for rows an older build left")
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("fin close: ok")

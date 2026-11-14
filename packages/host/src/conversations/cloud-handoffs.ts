import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import { PARKED_PER_THREAD_MAX, QUIET_OTHERS_MAX, QUIET_THREADS_MAX, type QuietRepository, type AcknowledgedCheckpoint, type QuietAnswer, type QuietNote, type QuietRefusal, type QuietThread } from "@mako/protocol/handoff"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { goesOff, SHUTDOWN_HOLD_MS, type HandOffCandidate, type HandOffResult, type HandOffSettings, type ThreadHandOff, type ThreadMoveOutcome } from "../contracts/cloud-threads.js"
import type { LiveSnapshot, LiveSummary } from "../contracts/live-conversations.js"
import { isBusyNativeAgent } from "../contracts/native-agents.js"
import type { SessionExecution } from "../contracts/thread-execution.js"
import type { SessionId, ThreadPlacement } from "../contracts/thread-identity.js"
import { namedUuid } from "./cloud-moves.js"

const SettingsFileSchema = z.object({ version: z.literal(1), onSleep: z.boolean() })

/** A Thread of this Mac's at work: its conversation that works, the one the move is asked from. */
export type WorkingThread = { conversationId: string; thread: string; title?: string; harness: string }

export type CloudHandOffsOptions = {
  /** Where the person's choice is kept: `<data root>/cloud/handoff.json`. */
  file: string
  /** This Mac's Threads whose agents are working, owned here: one conversation each. */
  working(): WorkingThread[]
  moves: {
    move(conversationId: string, move: string, handOff?: ThreadHandOff, options?: { answer?: "released" | "handed" }): Promise<ThreadMoveOutcome>
    refusal(conversationId: string): Promise<string | undefined>
    /** Whether a move of `thread` runs in this host now (`CloudMoves.leaving`). */
    leaving(thread: string): boolean
    /** Waits until `deadline` at most for every move running here to settle; answers how many still run (`CloudMoves.settled`). */
    settled(deadline: number): Promise<number>
    /** The Thread's turns paused and parked as this Mac goes away, nothing of it moved (`CloudMoves.goAway`). */
    goAway?(conversationId: string, goingAway: string, handOff: ThreadHandOff): Promise<{ thread: string; sessions: Array<{ session: string; generation: number }>; parked: Array<{ conversation: string; request: string; continuation: string; stopped: string[] }> }>
  }
  /**
   * What a Mac going away (a sleep, a shutdown) takes: each Thread's last changes sent (`CloudReadiness.flush`), the
   * checkpoint the cloud acknowledged for it (`noteCheckpoint`), and the note to the account (`CloudAccount.quiet`).
   * Without it, a Mac going off moves each Thread at work, as a quit does.
   */
  goingAway?: {
    flush(working: WorkingThread[], by: number): Promise<void>
    checkpoint(thread: string): Promise<AcknowledgedCheckpoint | undefined>
    /** A project folder's other repositories, each with its acknowledged checkpoint (`CloudReadiness.noteOthers`). */
    others?(thread: string): Promise<QuietRepository[]>
    /**
     * Where the Thread's Sessions open on the machine when that isn't its standby's folder (`CloudReadiness.noteProject`):
     * a project folder's project worktree. Named only beside the checkpoint, whose standby it's around; the account
     * leaves it out for a gateway that doesn't take it (`CloudAccount.quiet`).
     */
    project?(thread: string): Promise<string | undefined>
    /** With `project`: the folder of this Mac's it mirrors, by which the account places each Session there (`CloudReadiness.noteProjectFrom`). */
    projectFrom?(thread: string): Promise<string | undefined>
    /**
     * Records the note as it goes (`CloudReadiness.noted`): which checkpoints each Thread's carried, after the account
     * left out what its gateway doesn't take. The way back takes a Thread's changes out of the project folder only where
     * the note carried them. Without it, nothing is recorded, and nothing leaves.
     */
    /** A going-away starts: the held Sessions' owner isn't asked until this Mac is back (`AwayNotes.going`). */
    going?(): void
    /** The going-away's note was answered, or won't be: from now the account's link checked again is this Mac back (`AwayNotes.answered`). */
    answered?(): void
    noted?(sent: QuietNote): Promise<void>
    /** The account took none of these Threads of the note (it refused them, or took no notes): their record of it goes. */
    refused?(note: string, threads: readonly string[]): Promise<void>
    /** Sends the note (`CloudAccount.quiet`), handing `record` the very note that goes, before it does. */
    quiet(note: QuietNote, record?: (sent: QuietNote) => Promise<void>): Promise<QuietAnswer | "unserved">
    /**
     * These Sessions wait for the account's word from now (`AwayNotes.noted`): every one paused, as soon as it is, so no
     * message queued meanwhile runs one before the note is answered; then those the account took, or every one if its
     * answer never came. Narrowing the hold sends no parked turn on: they go on once this Mac is back and asks.
     */
    accepted(note: string, sessions: QuietThread["sessions"]): Promise<void>
    /**
     * This Mac's own rows as the account lists them now: each Session's state there. The account takes a note only for
     * Sessions it lists as this Mac's and idle, so the note waits for the paused turns to read idle. Without it, the
     * note goes once the flush is done.
     */
    rows?(): Promise<ReadonlyMap<string, string>>
    /**
     * The account hears this Mac go quiet at once (`CloudAccount.leaving`, its runtime's `going-quiet`), once the note is
     * out: the account continues a noted Thread only once its device is quiet, and a sleep's own word of it (the desktop's
     * `suspend`) may come after the network is gone, or not at all.
     */
    goneQuiet?(why: "sleep" | "quit"): void
  }
  /** Why this Mac can't hand off now (signed out of the cloud); undefined when it can. */
  unavailable(): Promise<string | undefined>
  /** The person's choice changed: windows hear it. */
  changed(settings: HandOffSettings): void
}

/**
 * Handing this Mac's working agents to the cloud, all at once: when the person quits and chooses to, and as the Mac
 * goes to sleep when they let it. Each Thread at work moves by `CloudMoves`' handoff (its turns paused, carried and
 * continued there), one move per Thread, all at the same time. Each move is named by the handoff and the Thread, so a
 * handoff asked again joins its moves rather than starting others.
 */
export class CloudHandOffs {
  readonly #options: CloudHandOffsOptions
  #onSleep: boolean | undefined
  /** Handoffs running now: what a host stopping, and the cloud hearing this Mac go quiet, wait for (`underWay`). */
  readonly #underWay = new Set<Promise<HandOffResult[]>>()

  constructor(options: CloudHandOffsOptions) {
    this.#options = options
  }

  /** The Threads at work here, each with why it couldn't go, if it couldn't. */
  async candidates(): Promise<HandOffCandidate[]> {
    const unavailable = await this.#options.unavailable()
    return Promise.all(this.#options.working().map(async (working) => {
      const refusal = unavailable ?? (await this.#options.moves.refusal(working.conversationId))
      return { ...working, ...refusal && { refusal } }
    }))
  }

  /**
   * Hands every Thread at work here to the cloud, each as one move named by `handOff` and the Thread. Answers how each
   * went:
   *
   * - On quit, each once this Mac let go of it (`released`): the host carries the rest after the window closes.
   * - As the Mac sleeps or shuts down (`releaseBy`), each once the cloud carries it through (`handed`: this Mac sent
   *   what only it has), or, if it couldn't be released by then, left here with its turns paused (`goesOff`); and,
   *   until `releaseBy`, every move already running here (a quit's, a person's) to the same point, so the Mac never
   *   goes off holding what a Thread it let go of still needs. A Thread already moving isn't moved again.
   */
  handOff(handOff: string, why: ThreadHandOff["why"], releaseBy?: number): Promise<HandOffResult[]> {
    const work = this.#handOff(handOff, why, releaseBy)
    this.#underWay.add(work)
    void work.finally(() => this.#underWay.delete(work)).catch(() => undefined)
    return work
  }

  /** Waits until every handoff running now answered, or until `deadline`. */
  async underWay(deadline: number): Promise<void> {
    if (!this.#underWay.size) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(this.#underWay),
      new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())) }),
    ])
    clearTimeout(timer)
  }

  async #handOff(handOff: string, why: ThreadHandOff["why"], releaseBy?: number): Promise<HandOffResult[]> {
    if ((why === "sleep" || why === "shutdown") && this.#options.goingAway && this.#options.moves.goAway) return this.#goAway(this.#options.goingAway, handOff, why, releaseBy)
    const began = performance.now()
    const unavailable = await this.#options.unavailable()
    const working = this.#options.working().filter(({ thread }) => !this.#options.moves.leaving(thread))
    const results = await Promise.all(working.map(async ({ conversationId, thread }): Promise<HandOffResult> => {
      if (unavailable) return { conversationId, outcome: { kind: "kept-here", reason: unavailable } }
      try {
        const move = namedUuid(`mako handoff\0${handOff}\0${thread}`)
        const options = { answer: why === "quit" ? "released" as const : "handed" as const }
        return { conversationId, outcome: await this.#options.moves.move(conversationId, move, { why, ...releaseBy !== undefined && { releaseBy } }, options) }
      } catch (error) {
        return { conversationId, outcome: { kind: "kept-here", reason: errorMessage({ error }) } }
      }
    }))
    const inFlight = goesOff({ why }) && releaseBy !== undefined ? await this.#options.moves.settled(releaseBy) : 0
    const gone = results.filter((result) => goneFromHere(result.outcome)).length
    const log = gone === results.length && !inFlight ? hostLog : hostWarn
    log("handoff", "agents at work handed to the cloud", {
      why, threads: results.length, moved: gone, ms: Math.round(performance.now() - began),
      stayed: results.filter((result) => !goneFromHere(result.outcome)).map((result) => `${result.conversationId}: ${"reason" in result.outcome ? result.outcome.reason : ""}`).join("; "),
      ...inFlight && { stillMoving: inFlight },
    })
    return results
  }

  /**
   * As this Mac sleeps or shuts down: each Thread at work paused and parked, nothing of it moved; its last changes
   * sent, `FLUSH_MS` and the Mac's deadline at most; then the account told this Mac is going away, naming each Thread,
   * its Sessions at their generations and the checkpoint the cloud acknowledged, from which it may continue the Thread
   * while the Mac is quiet. Nothing here waits for that: a Thread the account doesn't take goes on here once the Mac is back.
   */
  async #goAway(goingAway: NonNullable<CloudHandOffsOptions["goingAway"]>, handOff: string, why: "sleep" | "shutdown", releaseBy: number | undefined): Promise<HandOffResult[]> {
    const began = performance.now()
    const deadline = releaseBy ?? Number.POSITIVE_INFINITY
    const unavailable = await this.#options.unavailable()
    const working = this.#options.working().filter(({ thread }) => !this.#options.moves.leaving(thread))
    if (unavailable || !working.length) return working.map(({ conversationId }) => ({ conversationId, outcome: { kind: "kept-here", reason: unavailable ?? "" } }))
    goingAway.going?.()
    const handing: ThreadHandOff = { why, ...releaseBy !== undefined && { releaseBy } }
    const parked = await Promise.all(working.map(async (each) => {
      try {
        return { ...each, gone: await this.#options.moves.goAway!(each.conversationId, handOff, handing) }
      } catch (error) {
        return { ...each, error: errorMessage({ error }) }
      }
    }))
    // Held from the moment they're paused: a message queued before the note is answered (a Fin's report) waits too.
    try {
      await goingAway.accepted(handOff, parked.flatMap((each) => ("gone" in each && each.gone.parked.length ? each.gone.sessions : [])))
    } catch (error) {
      hostWarn("handoff", "the Sessions paused as this Mac went away couldn't be held; a message queued meanwhile may run", { error: errorMessage({ error }) })
    }
    // Whatever happens after the Sessions were parked, the going-away settles (`answered`): a flush, a read or a note that
    // throws would otherwise leave nothing to say this Mac is back, and the held Sessions waiting for a wake or a restart.
    try {
      const pausedMs = performance.now() - began
      const sessions = parked.flatMap((each) => ("gone" in each ? each.gone.sessions.map((session) => session.session) : []))
      const [, rows] = await Promise.all([
        goingAway.flush(working, Math.min(Date.now() + FLUSH_MS, deadline)),
        idleRows(goingAway, sessions, Math.min(Date.now() + IDLE_WAIT_MS, deadline)),
      ])
      const flushedMs = performance.now() - began - pausedMs
      const threads: QuietThread[] = []
      for (const each of parked) {
        if (!("gone" in each) || !each.gone.parked.length) continue
        // Only the Sessions the account lists as this Mac's: one it has no row of would have it refuse the whole Thread.
        const listed = rows ? each.gone.sessions.filter((session) => rows.has(session.session)) : each.gone.sessions
        if (!listed.length) continue
        const checkpoint = await goingAway.checkpoint(each.gone.thread)
        // The others only beside the first's: their arrival is laid over the first's, all or nothing.
        const others = checkpoint ? ((await goingAway.others?.(each.gone.thread)) ?? []).slice(0, QUIET_OTHERS_MAX) : []
        const project = checkpoint && (await goingAway.project?.(each.gone.thread))
        const projectFrom = project && (await goingAway.projectFrom?.(each.gone.thread))
        const parked = each.gone.parked.slice(0, PARKED_PER_THREAD_MAX).map(({ stopped, ...turn }) => ({ ...turn, ...stopped.length && { stopped } }))
        threads.push({ thread: each.gone.thread, sessions: listed, parked, ...checkpoint && { checkpoint }, ...others.length && { others }, ...project && { project }, ...projectFrom && { projectFrom } })
      }
      const note: QuietNote = { note: handOff, reason: why, at: Date.now(), threads: threads.slice(0, QUIET_THREADS_MAX) }
      let heard: NoteHeard
      try {
        const record = goingAway.noted && ((sent: QuietNote) => goingAway.noted!(sent))
        heard = await answeredBy(goingAway.quiet(note, record), deadline)
      } catch (error) {
        hostWarn("handoff", "the account didn't hear this Mac go away; its Threads wait here, paused", { why, error: errorMessage({ error }) })
        heard = { kind: "unanswered" }
      }
      const results = parked.map((each): HandOffResult => {
        if (!("gone" in each)) return { conversationId: each.conversationId, outcome: { kind: "kept-here", reason: each.error } }
        const word = heard.kind === "answered" ? heard.answer.threads.find((known) => known.thread === each.gone.thread) : undefined
        return { conversationId: each.conversationId, outcome: { kind: "kept-here", reason: goingAwayWords(heard, word) } }
      })
      // A note whose answer didn't come may have been taken all the same: its Sessions wait for the account's word as if it
      // had, and an owner ask lets them go if it wasn't. Only a gateway that takes no notes (`unserved`) took none.
      const taken = heard.kind === "answered" ? new Set(heard.answer.threads.filter((each) => each.accepted).map((each) => each.thread))
        : heard.kind === "unanswered" ? new Set(note.threads.map((each) => each.thread)) : new Set<string>()
      // Only the Threads the account took keep this note's record: nothing is continued from it for the rest.
      const untaken = note.threads.filter((each) => !taken.has(each.thread)).map((each) => each.thread)
      if (untaken.length)
        await goingAway.refused?.(note.note, untaken).catch((error: Error) => hostWarn("handoff", "a refused note's record couldn't be dropped; no continue comes from it", { error: error.message }))
      try {
        await goingAway.accepted(note.note, note.threads.filter((each) => taken.has(each.thread)).flatMap((each) => each.sessions))
      } catch (error) {
        hostWarn("handoff", "the Sessions the account may continue couldn't be kept; they go on here when this Mac is back", { error: errorMessage({ error }) })
      }
      goingAway.goneQuiet?.(why === "sleep" ? "sleep" : "quit")
      const accepted = taken.size
      hostLog("handoff", "agents at work paused as this Mac went away", {
        why,
        threads: working.length,
        noted: threads.length,
        withCheckpoint: threads.filter((each) => each.checkpoint).length,
        ...rows && { notIdle: sessions.filter((session) => rows.has(session) && rows.get(session) !== "idle").length },
        accepted,
        answer: heard.kind,
        pausedMs: Math.round(pausedMs),
        flushedMs: Math.round(flushedMs),
        ms: Math.round(performance.now() - began),
        ...parked.some((each) => "error" in each) && { stayed: parked.flatMap((each) => ("error" in each ? [`${each.conversationId}: ${each.error}`] : [])).join("; ") },
      })
      return results
    } catch (error) {
      hostWarn("handoff", "going away stopped partway; it settles, and the held Sessions are asked about once this Mac is back or two minutes on", { why, error: errorMessage({ error }) })
      throw error
    } finally {
      goingAway.answered?.()
    }
  }

  /** The person's choice, and whether this Mac can act on it now. */
  async settings(): Promise<HandOffSettings> {
    const unavailable = await this.#options.unavailable()
    return { onSleep: await this.#readOnSleep(), ...unavailable && { unavailable } }
  }

  /** Whether agents at work go to the cloud as this Mac sleeps: on by default once the cloud is. */
  async onSleep(): Promise<boolean> {
    return this.#readOnSleep()
  }

  async setOnSleep(onSleep: boolean): Promise<HandOffSettings> {
    this.#onSleep = onSleep
    await mkdir(dirname(this.#options.file), { recursive: true })
    await writeFile(`${this.#options.file}.tmp`, JSON.stringify(SettingsFileSchema.parse({ version: 1, onSleep })), { mode: 0o600 })
    await rename(`${this.#options.file}.tmp`, this.#options.file)
    const settings = await this.settings()
    this.#options.changed(settings)
    return settings
  }

  async #readOnSleep(): Promise<boolean> {
    if (this.#onSleep !== undefined) return this.#onSleep
    const saved = SettingsFileSchema.safeParse(JSON.parse(await readFile(this.#options.file, "utf8").catch(() => "null")))
    this.#onSleep = saved.success ? saved.data.onSleep : true
    return this.#onSleep
  }
}

/** What going away waits for a Thread's last changes to reach the cloud, at most. */
const FLUSH_MS = 5_000
/** And for the account to list its paused turns idle, which it takes a note for only then. */
const IDLE_WAIT_MS = 4_000
const IDLE_LOOK_MS = 250

/**
 * This Mac's rows as the account lists them, read until every one of `sessions` it lists reads idle, or `until`: the
 * last read, or undefined when none could be read (the note goes naming every Session, as without rows).
 */
async function idleRows(goingAway: { rows?(): Promise<ReadonlyMap<string, string>> }, sessions: readonly string[], until: number): Promise<ReadonlyMap<string, string> | undefined> {
  if (!goingAway.rows || !sessions.length) return undefined
  let last: ReadonlyMap<string, string> | undefined
  for (;;) {
    try {
      last = await goingAway.rows()
      const rows = last
      if (sessions.every((session) => !rows.has(session) || rows.get(session) === "idle")) return last
    } catch {
      // Unread this time: looked at again until `until`.
    }
    if (Date.now() + IDLE_LOOK_MS >= until) return last
    await new Promise((resolve) => setTimeout(resolve, IDLE_LOOK_MS))
  }
}

/** What became of a going-away's note: the account's answer, a gateway that takes none yet, or none by the deadline. */
type NoteHeard = { kind: "answered"; answer: QuietAnswer } | { kind: "unserved" } | { kind: "unanswered" }

/** The account's word on the note, or `unanswered` once `deadline` passes first. */
async function answeredBy(work: Promise<QuietAnswer | "unserved">, deadline: number): Promise<NoteHeard> {
  const heard = work.then((answer): NoteHeard => (answer === "unserved" ? { kind: "unserved" } : { kind: "answered", answer }))
  if (deadline === Number.POSITIVE_INFINITY) return heard
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<NoteHeard>((resolve) => { timer = setTimeout(() => resolve({ kind: "unanswered" }), Math.max(0, deadline - Date.now())) })
  try {
    return await Promise.race([heard, late])
  } finally {
    clearTimeout(timer)
  }
}

const REFUSED = {
  "not-yours": "The account doesn't have it as this Mac's",
  stale: "The account has it at another point than this Mac",
  "no-checkpoint": "None of its changes had reached Mako Cloud yet",
  "auto-off": "Moving agents to the cloud when this Mac is off is turned off",
} satisfies Record<QuietRefusal, string>

/** What a Thread paused as this Mac went away says of where it goes on. */
function goingAwayWords(heard: NoteHeard, word: QuietAnswer["threads"][number] | undefined): string {
  const here = "it goes on here when this Mac is back, or Continue in the cloud from another device takes it."
  if (word?.accepted) return "Paused while this Mac is away. If it's still away in a couple of minutes, Mako Cloud goes on with it from its last changes; otherwise it goes on here."
  if (word && !word.accepted) return `Paused while this Mac is away. ${REFUSED[word.why]}, so ${here}`
  if (heard.kind === "unserved") return `Paused while this Mac is away. Mako Cloud can't go on with it by itself yet, so ${here}`
  return `Paused while this Mac is away. Mako Cloud didn't hear it go, so ${here}`
}

export { SHUTDOWN_HOLD_MS }
/** What a shutdown's hold leaves after the handoff: its answer reaching the desktop app, which then quits. */
const SHUTDOWN_ANSWER_MS = 1_500

export type MachineLeavingOptions = {
  handOffs: Pick<CloudHandOffs, "handOff" | "underWay"> | undefined
  /** Whether agents at work go to the cloud as this Mac goes off: the person's choice, and a Mac able to. */
  enabled(): Promise<boolean>
  /** The cloud hears this Mac go quiet (`CloudAccount.leaving`). */
  quiet(why: "sleep" | "quit"): void
  holdMs?: number
}

/**
 * This Mac going to sleep or shutting down, as its desktop app heard it. A shutdown hands every Thread at work to the
 * cloud as a sleep does (`SleepHandOff`), within its hold. Either way the cloud hears this Mac go quiet once the
 * handoff under way answered, never before: a quiet Mac's runtime link carries no move.
 */
export async function machineLeaving(source: "suspend" | "shutdown", options: MachineLeavingOptions): Promise<void> {
  const deadline = Date.now() + (options.holdMs ?? SHUTDOWN_HOLD_MS)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { handOffs } = options
    if (source === "shutdown" && handOffs && (await options.enabled())) {
      await Promise.race([
        handOffs.handOff(randomUUID(), "shutdown", deadline - SHUTDOWN_ANSWER_MS),
        new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - SHUTDOWN_ANSWER_MS - Date.now())) }),
      ])
    } else await handOffs?.underWay(deadline)
  } catch (error) {
    hostWarn("handoff", "agents at work couldn't be handed off as this Mac went off", { source, error: errorMessage({ error }) })
  } finally {
    clearTimeout(timer)
    options.quiet(source === "suspend" ? "sleep" : "quit")
  }
}

/** What `workingThreads` reads of a conversation: whether its agent works, and its harness and title. */
export type WorkingSnapshot = Pick<LiveSnapshot, "permissions" | "nativeAgents"> & {
  session: Pick<LiveSnapshot["session"], "harness" | "status" | "title" | "backgroundTasks">
  requests: ReadonlyArray<Pick<LiveSnapshot["requests"][number], "status">>
}

/** What `workingThreads` reads of the live conversations and the Thread store. */
export type WorkingSources = {
  live: { listed(): ReadonlyArray<{ session: Pick<LiveSummary["session"], "id"> }>; held(id: string): WorkingSnapshot | undefined }
  threads: { journalPlacement(conversationId: string): ThreadPlacement | undefined; execution(session: SessionId): Pick<SessionExecution, "state"> | undefined } | undefined
  /** Whether a conversation runs on a cloud machine already (`CloudConversations.has`). */
  cloud(conversationId: string): boolean
  /** Only what an agent does itself (`doingItself`), not what waits on the person; a handoff takes both, so it's off by default. */
  ownWork?: boolean
}

/**
 * Whether an agent here is doing something itself. A turn stopped on an approval or a question still reads running with
 * its request dispatching, but it's the person who's awaited; what it left running goes on regardless. A Fin is a Thread
 * of its own, counted by its own conversation, so one open in a roster is no work of this one's.
 */
function doingItself(snapshot: WorkingSnapshot, running: boolean): boolean {
  if (running && snapshot.permissions.length === 0) return true
  return Boolean(snapshot.session.backgroundTasks) || (snapshot.nativeAgents?.agents ?? []).some((agent) => isBusyNativeAgent(agent) && !agent.child)
}

/**
 * This Mac's Threads whose agents are working now: a turn running, an approval or a question waiting, or work the turn
 * left running in the background. One conversation each, a running one first, the one a handoff asks from.
 */
export function workingThreads(sources: WorkingSources): WorkingThread[] {
  const { threads } = sources
  if (!threads) return []
  const byThread = new Map<string, WorkingThread & { running: boolean }>()
  for (const summary of sources.live.listed()) {
    const id = summary.session.id
    if (sources.cloud(id)) continue
    // A work check reads resident metadata only: snapshot() would flush its pending transcript batch to SQLite.
    // One only on disk is at rest (memory keeps whatever works), and is never loaded for this check.
    const snapshot = sources.live.held(id)
    if (!snapshot) continue
    const placed = threads.journalPlacement(id)
    if (!placed || threads.execution(placed.session)?.state !== "here") continue
    const running = snapshot.session.status === "running" || snapshot.requests.some((request) => request.status === "dispatching")
    const working = sources.ownWork ? doingItself(snapshot, running) : running || snapshot.permissions.length > 0 || Boolean(snapshot.session.backgroundTasks) || (snapshot.nativeAgents?.agents ?? []).some(isBusyNativeAgent)
    if (!working) continue
    const known = byThread.get(placed.thread)
    if (known && (known.running || !running)) continue
    byThread.set(placed.thread, { conversationId: id, thread: placed.thread, harness: snapshot.session.harness, running, ...snapshot.session.title && { title: snapshot.session.title } })
  }
  return [...byThread.values()].map(({ conversationId, thread, harness, title }) => ({ conversationId, thread, harness, ...title !== undefined && { title } }))
}

/** Whether a handoff's Thread left here: started in the cloud, or released with the rest carried by this host. */
export function goneFromHere(outcome: ThreadMoveOutcome): boolean {
  return outcome.kind === "moved" || outcome.kind === "released"
}

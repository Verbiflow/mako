import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { HandOffCandidate, HandOffResult, HandOffSettings, ThreadHandOff, ThreadMoveOutcome } from "../contracts/cloud-threads.js"
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
    move(conversationId: string, move: string, handOff?: ThreadHandOff, options?: { answer?: "released" }): Promise<ThreadMoveOutcome>
    refusal(conversationId: string): Promise<string | undefined>
    /** Whether a move of `thread` runs in this host now (`CloudMoves.leaving`). */
    leaving(thread: string): boolean
    /** Waits until `deadline` at most for every move running here to settle; answers how many still run (`CloudMoves.settled`). */
    settled(deadline: number): Promise<number>
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
   * - As the Mac sleeps (`releaseBy`), each once it started in the cloud, or left here untouched if it couldn't be
   *   released by then; and, until `releaseBy`, every move already running here (a quit's, a person's) too, so the
   *   Mac never sleeps with a Thread it let go of between here and the cloud. A Thread already moving isn't moved again.
   */
  async handOff(handOff: string, why: ThreadHandOff["why"], releaseBy?: number): Promise<HandOffResult[]> {
    const began = performance.now()
    const unavailable = await this.#options.unavailable()
    const working = this.#options.working().filter(({ thread }) => !this.#options.moves.leaving(thread))
    const results = await Promise.all(working.map(async ({ conversationId, thread }): Promise<HandOffResult> => {
      if (unavailable) return { conversationId, outcome: { kind: "kept-here", reason: unavailable } }
      try {
        const move = namedUuid(`mako handoff\0${handOff}\0${thread}`)
        const options = why === "quit" ? { answer: "released" as const } : {}
        return { conversationId, outcome: await this.#options.moves.move(conversationId, move, { why, ...releaseBy !== undefined && { releaseBy } }, options) }
      } catch (error) {
        return { conversationId, outcome: { kind: "kept-here", reason: errorMessage({ error }) } }
      }
    }))
    const inFlight = why === "sleep" && releaseBy !== undefined ? await this.#options.moves.settled(releaseBy) : 0
    const gone = results.filter((result) => goneFromHere(result.outcome)).length
    const log = gone === results.length && !inFlight ? hostLog : hostWarn
    log("handoff", "agents at work handed to the cloud", {
      why, threads: results.length, moved: gone, ms: Math.round(performance.now() - began),
      stayed: results.filter((result) => !goneFromHere(result.outcome)).map((result) => `${result.conversationId}: ${"reason" in result.outcome ? result.outcome.reason : ""}`).join("; "),
      ...inFlight && { stillMoving: inFlight },
    })
    return results
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

/** What `workingThreads` reads of a conversation: whether its agent works, and its harness and title. */
export type WorkingSnapshot = Pick<LiveSnapshot, "permissions" | "nativeAgents"> & {
  session: Pick<LiveSnapshot["session"], "harness" | "status" | "title" | "backgroundTasks">
  requests: ReadonlyArray<Pick<LiveSnapshot["requests"][number], "status">>
}

/** What `workingThreads` reads of the live conversations and the Thread store. */
export type WorkingSources = {
  live: { summaries(): ReadonlyArray<{ session: Pick<LiveSummary["session"], "id"> }>; snapshot(id: string): WorkingSnapshot | null }
  threads: { journalPlacement(conversationId: string): ThreadPlacement | undefined; execution(session: SessionId): Pick<SessionExecution, "state"> | undefined } | undefined
  /** Whether a conversation runs on a cloud machine already (`CloudConversations.has`). */
  cloud(conversationId: string): boolean
}

/**
 * This Mac's Threads whose agents are working now: a turn running, an approval or a question waiting, or work the turn
 * left running in the background. One conversation each, a running one first, the one a handoff asks from.
 */
export function workingThreads(sources: WorkingSources): WorkingThread[] {
  const { threads } = sources
  if (!threads) return []
  const byThread = new Map<string, WorkingThread & { running: boolean }>()
  for (const summary of sources.live.summaries()) {
    const id = summary.session.id
    if (sources.cloud(id)) continue
    const placed = threads.journalPlacement(id)
    if (!placed || threads.execution(placed.session)?.state !== "here") continue
    const snapshot = sources.live.snapshot(id)
    if (!snapshot) continue
    const running = snapshot.session.status === "running" || snapshot.requests.some((request) => request.status === "dispatching")
    const working = running || snapshot.permissions.length > 0 || Boolean(snapshot.session.backgroundTasks) || (snapshot.nativeAgents?.agents ?? []).some(isBusyNativeAgent)
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

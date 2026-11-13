import { readFileSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import type { ListedContinue } from "@mako/protocol/continues"
import type { OwnerAnswer, OwnerAsk } from "@mako/protocol/handoff"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"

const AwayFileSchema = z.object({
  version: z.literal(1),
  note: z.string(),
  at: z.number(),
  sessions: z.array(z.object({ session: z.string(), generation: z.number().int().nonnegative() })),
})
type AwayFile = z.infer<typeof AwayFileSchema>

/** How long after a going-away's note settled this Mac, still running, takes it as one that didn't happen (`AwayNotes.lapse`). */
export const GOING_LAPSES_MS = 2 * 60_000

export type AwayNotesOptions = {
  /** Where the Sessions of the last note the account took are kept: `<data root>/cloud/away.json`. */
  file: string
  /** Asks the account who owns each Session (`CloudAccount.owner`); undefined while signed out. */
  owner(): ((ask: OwnerAsk) => Promise<OwnerAnswer | "unserved">) | undefined
  deviceId(): Promise<string | undefined>
  /** A continue took the Session: this Mac joins it and runs none of it here (`CloudMoves.joinContinue`). */
  join(session: string, listed: ListedContinue): void
  /** Sessions let go here: each parked turn of theirs goes on here (`CloudMoves.unpark`). */
  released(): void
  /** The held Sessions changed: windows hear which conversations wait (`away-held`). */
  changed?(sessions: readonly string[]): void
  now?(): number
}

/**
 * The Sessions a going-away's note named that the account took (`QuietAnswer` accepted): the account may continue
 * them while this Mac is quiet, so none of them runs here until the account says whose they are (`owner`). Unlike the
 * owner check's other holds, these never give up by a timer: an offline Mac back from sleep waits, and only the
 * person runs one here anyway (`runHere`). Kept on disk, so a Mac that shut down holds them from its first moment.
 *
 * `departed`: a continue took it; this Mac joins that continue, which holds the Session while it runs. `yours` or
 * `unknown`: it's this Mac's to run, and its parked turns go on here.
 */
export class AwayNotes {
  readonly #options: AwayNotesOptions
  #held: AwayFile | undefined
  #asking: Promise<void> | undefined
  /**
   * A going-away is under way: the account isn't asked until this Mac is back (`back`). Asked before the note goes, or
   * before this Mac is off, the account says the Sessions are this Mac's, as they are until it's quiet; they'd be let
   * go here, its parked turn would run, and an ask ends the quiet the account would continue them in. In memory only:
   * a host that starts is back. `answeredAt` once the note's answer came (or never will): only then does the account's
   * link checked again say this Mac is back, or the time since say the going-away didn't happen.
   */
  #going: { since: number; answeredAt?: number } | undefined
  #writing: Promise<void> = Promise.resolve()

  constructor(options: AwayNotesOptions) {
    this.#options = options
    try {
      const read = AwayFileSchema.safeParse(JSON.parse(readFileSync(options.file, "utf8")))
      this.#held = read.success && read.data.sessions.length ? read.data : undefined
    } catch {
      this.#held = undefined
    }
  }

  /** Since when `session` waits for the account's word; undefined when it doesn't. */
  holds(session: string): number | undefined {
    return this.#held?.sessions.some((each) => each.session === session) ? this.#held.at : undefined
  }

  /** Whether any Session waits for the account's word. */
  any(): boolean {
    return Boolean(this.#held?.sessions.length)
  }

  /** This Mac is going away: nothing asks the account whose the held Sessions are until it's back. */
  going(): void {
    this.#going = { since: this.#now() }
  }

  /** The going-away's note was answered, or won't be (unanswered, a gateway with no notes): the link may say it's back. */
  answered(): void {
    if (this.#going) this.#going.answeredAt ??= this.#now()
  }

  /**
   * This Mac is back, and asking goes on: by a wake, or (`link`) its account's link checked again. A link checked while
   * the note is still out says nothing of being back (the link was up as the Mac began to go), so it's ignored then.
   */
  back(by: "wake" | "link"): void {
    if (by === "link" && this.#going && this.#going.answeredAt === undefined) return
    this.#going = undefined
  }

  /**
   * A going-away that never happened (a quit or shutdown cancelled, a sleep the system aborted): this Mac still runs
   * `GOING_LAPSES_MS` after its note settled (`answered`), which no sleep or shutdown leaves it doing, so it's back. Never
   * while the note is still out: a sleep has no deadline, and its flush and note may take minutes on a slow network, and
   * an ask before the account heard the note would be told the Sessions are this Mac's. The job asking whose the held
   * Sessions are calls it on its round. True when it lapsed.
   */
  lapse(): boolean {
    const answeredAt = this.#going?.answeredAt
    if (answeredAt === undefined || this.#now() - answeredAt < GOING_LAPSES_MS) return false
    hostLog("away", "a going-away didn't happen: this Mac still runs, so it asks whose its held Sessions are again", { afterMs: this.#now() - answeredAt })
    this.#going = undefined
    return true
  }

  #now(): number {
    return (this.#options.now ?? Date.now)()
  }

  /** The account took a going-away's note: these Sessions wait for its word from now. */
  async noted(note: string, sessions: OwnerAsk["sessions"]): Promise<void> {
    this.#held = sessions.length ? { version: 1, note, at: (this.#options.now ?? Date.now)(), sessions: [...sessions] } : undefined
    await this.#save()
  }

  /**
   * Asks the account whose each held Session is, once at a time: a continue's are joined, the rest let go. Asked again
   * (on the next link, the next owner check, the job) while it can't be answered; nothing is let go meanwhile.
   */
  ask(): Promise<void> {
    if (!this.#held || this.#going) return Promise.resolve()
    this.#asking ??= this.#ask().finally(() => (this.#asking = undefined))
    return this.#asking
  }

  /** The person runs these Threads' Sessions here anyway, whatever the account did meanwhile: the only way past by hand. */
  async runHere(sessions: readonly string[] | "all"): Promise<number> {
    const held = this.#held
    if (!held) return 0
    const going = sessions === "all" ? held.sessions : held.sessions.filter((each) => sessions.includes(each.session))
    if (!going.length) return 0
    await this.#release(going.map((each) => each.session))
    hostLog("away", "the person runs Sessions here before the account said whose they are", { sessions: going.length })
    this.#options.released()
    return going.length
  }

  async #ask(): Promise<void> {
    const held = this.#held
    const owner = this.#options.owner()
    if (!held || !owner) return
    let answer: OwnerAnswer | "unserved"
    try {
      answer = await owner({ sessions: held.sessions })
    } catch (error) {
      hostWarn("away", "the account couldn't say whose the Sessions are yet; they wait", { sessions: held.sessions.length, error: errorMessage({ error }) })
      return
    }
    if (answer === "unserved") {
      // A gateway that can't answer took no note either: nothing of these was continued by it.
      await this.#release(held.sessions.map((each) => each.session))
      this.#options.released()
      return
    }
    const deviceId = (await this.#options.deviceId()) ?? ""
    const at = new Date((this.#options.now ?? Date.now)()).toISOString()
    let joined = 0
    for (const word of answer.sessions) {
      if (word.answer !== "departed") continue
      joined += 1
      this.#options.join(word.session, { op: word.op, phase: word.phase, from: deviceId, by: deviceId, cloudThread: word.cloudThread, at })
    }
    await this.#release(answer.sessions.map((word) => word.session))
    hostLog("away", "the account said whose the Sessions held as this Mac went away are", { sessions: answer.sessions.length, joined, here: answer.sessions.length - joined })
    this.#options.released()
  }

  async #release(sessions: readonly string[]): Promise<void> {
    const held = this.#held
    if (!held) return
    const left = held.sessions.filter((each) => !sessions.includes(each.session))
    this.#held = left.length ? { ...held, sessions: left } : undefined
    await this.#save()
  }

  /** The Sessions held now. */
  held(): string[] {
    return this.#held?.sessions.map((each) => each.session) ?? []
  }

  #save(): Promise<void> {
    this.#options.changed?.(this.held())
    const write = this.#writing.then(async () => {
      await mkdir(dirname(this.#options.file), { recursive: true })
      const tmp = `${this.#options.file}.tmp`
      await writeFile(tmp, JSON.stringify(this.#held ?? { version: 1, note: "", at: 0, sessions: [] }), { mode: 0o600 })
      await rename(tmp, this.#options.file)
    })
    this.#writing = write.catch(() => undefined)
    return write
  }
}

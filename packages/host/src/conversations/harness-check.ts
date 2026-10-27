import { restoreGate, type SessionWriters } from "@mako/sessions/record-writers"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { CloudHarnesses, HarnessAhead, HarnessBehind, ThreadHarnessCheck } from "../contracts/cloud-harnesses.js"
import type { HarnessUpdates } from "../contracts/harness-updates.js"
import { compareVersions } from "../contracts/runtime-version.js"
import { installedReading, type InstalledRuntime } from "./kept-resume.js"

/**
 * A Thread's harnesses here weighed against the cloud's, before it moves either way, by the one rule every restore
 * takes (`restoreGate`): records go only into the version that wrote them or a newer one.
 *
 * - Going: a Session whose newest writer here is newer than the cloud's version would be refused as it arrives
 *   (`MoveArrival`), after its machine started and this Mac let go of it. It's refused here instead (`ahead`).
 * - Coming back: once a Session works in the cloud, the cloud's version wrote it, so it comes back only into that
 *   version or a newer one here (`CloudReturns`). A harness here that's older is said before the move, with the update
 *   that settles it (`behind`), and before the way back, as one choice.
 *
 * What the cloud runs is what it says it runs (`CloudAccount.cloudHarnesses`): the record of the one image every
 * machine starts from. It changes only when the cloud makes machines from a new image, so it's held a while.
 */

/** How long what the cloud said is held before it's asked again: it changes only as the cloud makes machines from a new image. */
const HELD_MS = 10 * 60_000
/** How long a cloud that didn't say is left before it's asked again. */
const MISSED_MS = 60_000

export type HarnessCheckOptions = {
  /** The signed-in account, which asks the cloud; undefined while signed out. */
  account(): { cloudHarnesses?(): Promise<CloudHarnesses | null> } | undefined
  /** Who wrote the session at `path`, as Mako's record store knows (`SessionCatalog.recordWriters`). */
  writers(path: string): SessionWriters | null
  /** The harness here as a restore weighs it (`RuntimeUpdates.restoreRuntime`). */
  installed(harness: string): InstalledRuntime
  /**
   * Takes the harness's installed readings again (`RuntimeUpdates.reread`): one the person updated a moment ago, in
   * Mako or a terminal, is weighed as it is now, not as it was last read. Spawns only for a binary that changed.
   */
  reread(harness: string): Promise<void>
  /** The runtimes' readings (`RuntimeUpdates.snapshot`): what an update offer installs. */
  updates(): HarnessUpdates
  /** A harness's name as the person reads it, for a refusal's words. */
  label(harness: string): string
}

/** A Session a check weighs: its harness, and its native session's path here when it has one (a Thread still here). */
export type CheckedSession = { harness: string; path?: string }

type Held = { at: number; cloud: CloudHarnesses } | { at: number; missed: string }

export class HarnessCheck {
  readonly #options: HarnessCheckOptions
  #held: Held | undefined
  #asking: Promise<Held> | undefined

  constructor(options: HarnessCheckOptions) {
    this.#options = options
  }

  /** The Thread's Sessions weighed against what the cloud runs now. */
  async check(sessions: readonly CheckedSession[]): Promise<ThreadHarnessCheck> {
    const held = await this.#cloud()
    if ("missed" in held) return { kind: "unknown", reason: held.missed }
    const weighed = new Set(sessions.map((session) => session.harness).filter((harness) => held.cloud.harnesses[harness]))
    await Promise.all([...weighed].map((harness) => this.#options.reread(harness)))
    const check = weighHarnesses(held.cloud, sessions, this.#options)
    return check.kind === "known" && check.ahead.length ? { ...check, refusal: aheadRefusal(check.ahead, this.#options.label) } : check
  }

  async #cloud(): Promise<Held> {
    const held = this.#held
    if (held && Date.now() - held.at < ("cloud" in held ? HELD_MS : MISSED_MS)) return held
    this.#asking ??= this.#ask().finally(() => {
      this.#asking = undefined
    })
    // What the cloud said last answers at once while it's asked again, so a move (a sleep's, with moments to go) waits on
    // the network for it only the first time; the arrival's own check still holds if the image changed meanwhile.
    return held ?? this.#asking
  }

  async #ask(): Promise<Held> {
    const account = this.#options.account()
    if (!account) return { at: 0, missed: "This Mac isn't signed in to Mako Cloud." }
    const before = this.#held
    try {
      const cloud = (await account.cloudHarnesses?.()) ?? null
      if (!cloud) {
        this.#held = { at: Date.now(), missed: "The cloud doesn't say which harness versions its machines run." }
        return this.#held
      }
      if (!before || !("cloud" in before) || before.cloud.image !== cloud.image)
        hostLog("moves", "the cloud's machines run", { image: cloud.image, revision: cloud.revision.slice(0, 12), harnesses: Object.entries(cloud.harnesses).map(([harness, version]) => `${harness} ${version}`).join(", ") })
      this.#held = { at: Date.now(), cloud }
    } catch (error) {
      const reason = errorMessage({ error })
      hostWarn("moves", "the cloud's harness versions couldn't be read", { error: reason })
      this.#held = { at: Date.now(), missed: reason }
    }
    return this.#held
  }
}

/**
 * The weighing itself, given what the cloud runs: each Session it can't resume (`ahead`), and each harness here older
 * than the cloud's (`behind`), with the offer that gets it there. A harness the cloud doesn't run, or one whose
 * version here can't be read, is left out: nothing is known to refuse it.
 */
export function weighHarnesses(cloud: CloudHarnesses, sessions: readonly CheckedSession[], options: Pick<HarnessCheckOptions, "writers" | "installed" | "updates">): ThreadHarnessCheck {
  const ahead: HarnessAhead[] = []
  for (const session of sessions) {
    const there = cloud.harnesses[session.harness]
    if (!there || session.path === undefined) continue
    // A writer nothing names is left to the arrival, which knows how old its install is (`InstalledReading.since`).
    const gate = restoreGate(options.writers(session.path), there)
    if (gate.kind !== "older") continue
    const known = ahead.find((each) => each.harness === session.harness)
    if (!known) ahead.push({ harness: session.harness, wrote: gate.wrote.version, cloud: there })
    else if (compareVersions(gate.wrote.version, known.wrote) > 0) known.wrote = gate.wrote.version
  }
  const behind: HarnessBehind[] = []
  for (const harness of new Set(sessions.map((session) => session.harness))) {
    const there = cloud.harnesses[harness]
    if (!there) continue
    const installed = options.installed(harness)
    // What the cloud will have written, weighed as the way back weighs it.
    const gate = restoreGate({ record: [there], observed: [] }, installedReading(installed))
    if (gate.kind !== "older") continue
    behind.push({ harness, here: gate.installed, cloud: there, ...reaching(installed.offer, there, options.updates()) })
  }
  return { kind: "known", image: cloud.image, ahead, behind }
}

/**
 * The offer that brings a harness here to `cloud`. Mako's update installs this Mako's `tested` and never goes past
 * it, so when that's older than the cloud's, the way there is a newer Mako, which tested the cloud's version.
 */
function reaching(offer: InstalledRuntime["offer"], cloud: string, updates: HarnessUpdates): Pick<HarnessBehind, "offer" | "to"> {
  if (offer.kind !== "update") return { offer }
  const to = updates[offer.runtimeId]?.versions?.tested
  if (to === undefined) return { offer }
  return compareVersions(to, cloud) >= 0 ? { offer, to } : { offer: { kind: "owner", owner: "Mako" } }
}

/** Why a move is refused for what's `ahead`, in the person's words: what the cloud runs, what wrote it here, and when it can go. */
export function aheadRefusal(ahead: readonly HarnessAhead[], label: (harness: string) => string): string {
  const [one] = ahead
  const runs = listed(ahead.map((each) => `${label(each.harness)} ${each.cloud}`))
  if (ahead.length === 1 && one) return `The cloud runs ${runs}, older than the ${one.wrote} that wrote this Thread here, so it can't pick up there yet. It can move once the cloud runs ${one.wrote} or newer.`
  return `The cloud runs ${runs}, older than the ${listed(ahead.map((each) => `${label(each.harness)} ${each.wrote}`))} that wrote this Thread here, so it can't pick up there yet. It can move once the cloud runs those or newer.`
}

function listed(parts: readonly string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "")
}

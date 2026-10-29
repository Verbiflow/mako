import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { HostJobs } from "../base/host-jobs.js"
import type { MachineCapability } from "../base/machine.js"

const run = promisify(execFile)

/** How recently the person touched this Mac for it to count as their being at it: past this, its banners go unseen. */
export const ATTENDED_WITHIN_SECONDS = 120
/** How often a Mac in use says so: the account forgets it two minutes after the last word. */
const EVERY_MS = 60_000

/**
 * Whether a host can tell the account its person is at it: a Mac's, whose banners they see there. A host with no screen
 * (a proof's, `MAKO_SCREENLESS=1`) shows no banner, so nobody is ever at it, whoever uses the computer it runs on.
 */
export function attendable(machine: Pick<MachineCapability, "kind">, mac: boolean): boolean {
  return mac && machine.kind === "present"
}

/**
 * Seconds since the person last touched this Mac's keyboard, pointer or trackpad, as its HID system counts them; any app
 * in front counts, since a Mac in use shows Mako's banners wherever the person is working. Undefined if unread.
 */
export async function macIdleSeconds(): Promise<number | undefined> {
  const { stdout } = await run("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"], { timeout: 2_000 })
  const nanoseconds = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout)?.[1]
  return nanoseconds === undefined ? undefined : Number(BigInt(nanoseconds) / 1_000_000_000n)
}

/**
 * Tells the account while its person is at this Mac, so a notice for a Thread that needs them waits for them to leave
 * it rather than buzzing their phone beside the Mac's own banner. Said once a minute while they're here, and once when
 * they've gone; nothing at all while they're away. Only while signed in to the cloud. The minute is a host job
 * (`HostJobs.every`), so it stops with the host.
 */
export class CloudAttention {
  readonly #idle: () => Promise<number | undefined>
  readonly #say: (attending: boolean) => Promise<void>
  readonly #signedIn: () => boolean
  readonly #log: (message: string, fields?: Record<string, string | number>) => void
  #cancel: (() => void) | undefined
  #said: boolean | undefined
  #failing = false

  constructor(options: { idle: () => Promise<number | undefined>; say: (attending: boolean) => Promise<void>; signedIn: () => boolean; log: (message: string, fields?: Record<string, string | number>) => void }) {
    this.#idle = options.idle
    this.#say = options.say
    this.#signedIn = options.signedIn
    this.#log = options.log
  }

  /** Looks now, then once a minute on the host's jobs. */
  start(jobs: Pick<HostJobs, "every">): void {
    this.#cancel ??= jobs.every("tell the account whether the person is at this Mac", EVERY_MS, () => this.look(), { firstAfterMs: 0 })
  }

  stop(): void {
    this.#cancel?.()
    this.#cancel = undefined
  }

  /** Looks now: at a start, a wake, and once a minute. */
  async look(): Promise<void> {
    if (!this.#signedIn()) {
      this.#said = undefined
      return
    }
    try {
      const idle = await this.#idle()
      const attending = idle !== undefined && idle < ATTENDED_WITHIN_SECONDS
      // Here: said each minute, as the account forgets it. Gone: said once.
      if (!attending && this.#said !== true) return
      await this.#say(attending)
      if (attending !== this.#said) this.#log(attending ? "the person is at this Mac; the account holds their notices" : "the person left this Mac; the account sends what waited", idle === undefined ? {} : { idleSeconds: idle })
      this.#said = attending
      this.#failing = false
    } catch (error) {
      if (!this.#failing) this.#log("couldn't tell the account whether the person is at this Mac", { error: error instanceof Error ? error.message : String(error) })
      this.#failing = true
    }
  }
}

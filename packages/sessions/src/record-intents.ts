import { randomUUID } from "node:crypto"
import { readlinkSync } from "node:fs"
import { rm } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { onLinux, onMac } from "./platform.js"
import { probeLock, processStart, takeLock, type HeldLock } from "./record-locks.js"

/**
 * Who is writing chunks no version names yet.
 *
 * A capture appends chunks to the packs and indexes them, committing as it
 * goes (`RecordStore.slice`), and names them only once the version that
 * holds them is written. A capture cut short (killed, crashed, failed)
 * leaves chunks that nothing names. So the first chunk a capture stores
 * registers an **intent** in the same transaction (`intents`), and every
 * chunk it stores carries that intent (`chunks.intent`). The capture's last
 * transaction deletes the intent with the stamp; a capture that fails marks
 * it `ended`; one whose process died leaves it open.
 *
 * An intent belongs to an **owner**, one open store in one process: its id,
 * pid, start (Linux), the namespace those mean something in (`scope`), and a
 * kernel-held lock (`record-locks.ts`) taken with its first intent and held
 * until the store closes. The repack (`record-repack.ts`) drops an intent's
 * unnamed chunks only once its capture failed or its owner is provably gone.
 */

/** Where owners' locks are named from (on macOS, the lock files). */
export const OWNERS = "owners"
/**
 * An open intent whose owner can't be asked from here (another container's
 * namespace, no lock and a pid that can't be told apart) is taken as
 * abandoned after this long: no capture runs for a week.
 */
export const STALE_INTENT_MS = 7 * 24 * 60 * 60_000

export function ownerLockPath(folder: string, owner: string): string {
  return join(folder, OWNERS, `${owner}.lock`)
}

/**
 * Where a pid and an abstract socket name mean one thing: on Linux the
 * machine's name and this process's pid and network namespaces, so an owner
 * in another container sharing the store is never judged by this one's
 * processes; empty elsewhere, where the lock file is the machine's own.
 */
export function processScope(): string {
  if (!onLinux()) return ""
  try {
    return `${hostname()} ${readlinkSync("/proc/self/ns/pid")} ${readlinkSync("/proc/self/ns/net")}`
  } catch {
    // No /proc: the name alone, and the stale rule for what it can't tell apart.
    return hostname()
  }
}

/** One open store's identity as the owner of its captures' intents. */
export class IntentOwner {
  readonly id = randomUUID()
  readonly pid = process.pid
  readonly start = processStart(process.pid)
  readonly scope = processScope()
  private lock: Promise<HeldLock | null> | null = null

  constructor(private readonly folder: string) {}

  /**
   * Takes this owner's lock once, before its first intent commits, and keeps
   * it while the store is open. False where the kernel can't hold one (no
   * abstract socket): the intent says so, and its pid is all that answers.
   */
  async locked(): Promise<boolean> {
    this.lock ??= takeLock(ownerLockPath(this.folder, this.id)).catch(() => null)
    return (await this.lock) !== null
  }

  /** Lets go of the lock, once the store has ended its intents. */
  async release(): Promise<void> {
    const held = await this.lock
    this.lock = null
    if (!held) return
    await held.release()
    if (onMac()) await rm(ownerLockPath(this.folder, this.id), { force: true })
  }
}

export const IntentRowSchema = z.object({
  id: z.number(),
  owner: z.string(),
  scope: z.string(),
  pid: z.number(),
  start: z.number().nullable(),
  locked: z.number(),
  session: z.string(),
  began: z.number(),
  ended: z.number().nullable(),
})
export type IntentRow = z.infer<typeof IntentRowSchema>

/**
 * What an intent's capture is now. `failed` and `gone` let the repack drop
 * what it stored and no version names; `running` and `unknown` keep it.
 */
export interface IntentStanding {
  state: "running" | "failed" | "gone" | "unknown"
  reason: string
}

export const droppable = (standing: IntentStanding | undefined): boolean => standing?.state === "failed" || standing?.state === "gone"

/**
 * Whether `pid` is the process that took the intent: alive and, where the
 * platform says when it started (Linux), started then. Null when only its
 * being alive is known.
 */
function sameProcess(pid: number, start: number | null): boolean | null {
  try {
    process.kill(pid, 0)
  } catch (error) {
    // EPERM: another user's process holds the pid; alive, and told apart only by its start.
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
  }
  const now = start === null ? null : processStart(pid)
  if (start === null || now === null) return null
  return now === start
}

/**
 * The intent's capture as this process can prove it: failed, its owner gone
 * (the owner's lock free and its pid not the same process), running (the
 * lock held, or the pid still the same process), or unknown (another
 * namespace, or nothing to ask). Proof only: what can't be proven is kept,
 * until `STALE_INTENT_MS`.
 */
export async function intentStanding(folder: string, intent: IntentRow, now = Date.now()): Promise<IntentStanding> {
  if (intent.ended !== null) return { state: "failed", reason: `its capture failed at ${new Date(intent.ended).toISOString()} and named none of these` }
  const stale = now - intent.began >= STALE_INTENT_MS
  if (intent.scope !== processScope())
    return stale
      ? { state: "gone", reason: `taken in another namespace or machine (${intent.scope || "no scope"}) over a week ago; no capture runs that long` }
      : { state: "unknown", reason: `taken in another namespace or machine (${intent.scope || "no scope"}), whose processes this one can't see` }
  const same = sameProcess(intent.pid, intent.start)
  const lock = intent.locked ? await probeLock(ownerLockPath(folder, intent.owner)) : "unknown"
  if (lock === "held") return { state: "running", reason: `pid ${intent.pid} holds its owner's lock` }
  if (lock === "free") {
    if (same === true) return { state: "running", reason: `its owner's lock is free, but pid ${intent.pid} is still the process that took it` }
    // Where only being alive is known (macOS), the lock is the proof: the kernel let go of it with the process, and a pid can be reused.
    return { state: "gone", reason: same === false ? `its owner's lock is free and pid ${intent.pid} has exited` : `its owner's lock is free: pid ${intent.pid} ended, or closed the store` }
  }
  if (same === false) return { state: "gone", reason: `pid ${intent.pid} ${intent.start === null ? "has exited" : "has exited, or is another process now"}${intent.locked ? "" : " (it held no lock)"}` }
  if (stale) return { state: "gone", reason: `begun over a week ago, and pid ${intent.pid} can't be told from another process; no capture runs that long` }
  return { state: same === true ? "running" : "unknown", reason: intent.locked ? `its owner's lock can't be asked here; pid ${intent.pid} still runs` : `it held no lock; pid ${intent.pid} still runs` }
}

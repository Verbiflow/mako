import { hostLog, hostWarn } from "@mako/host/base/host-log"
import type { Relocation } from "@mako/host/workspaces"
import { activeBinding, launched, type LiveAccess, type Resident } from "./live-runtime.js"

type RelocationAccess = Pick<LiveAccess, "dependencies" | "load" | "flush" | "hibernate" | "wake" | "reopens" | "moves">

/**
 * Conversations moving to another folder under their own native session, as
 * a Thread's move into its worktree moves them, when their harness goes on
 * there (`resume.elsewhere`).
 */
export class LiveRelocations {
  private readonly access: RelocationAccess
  private readonly waiters = new Set<() => void>()

  constructor(access: RelocationAccess) {
    this.access = access
  }

  /**
   * Move an idle conversation to another folder: the provider sleeps and the
   * folder changes. One that hasn't launched yet just changes folder, and
   * like any fork made in another folder, starts there from its transcript
   * rather than by forking its source's native session. Returns the folder
   * it left, or undefined, with nothing changed, when it can't; the caller
   * forks instead. `resumeMoved` proves the move.
   */
  async relocate(id: string, cwd: string): Promise<string | undefined> {
    const resident = this.access.load(id)
    if (!resident || this.relocates(resident).kind !== "now") return undefined
    const from = resident.snapshot.session.cwd
    if (from === cwd) return from
    if (resident.driver) await this.access.hibernate(resident, "workspace-move")
    const native = launched(activeBinding(resident))
    if (resident.driver || resident.waking || resident.opening || resident.closing || (native && !this.access.reopens(resident))) return undefined
    const { control } = resident.snapshot
    const ancestry = control?.ancestry
    resident.snapshot = {
      ...resident.snapshot,
      session: { ...resident.snapshot.session, cwd },
      ...!native && control && ancestry?.nativeFork && { control: { ...control, ancestry: { ...ancestry, nativeFork: undefined } } },
    }
    this.access.flush(resident)
    hostLog("residency", "conversation relocated", { conversation: id, harness: resident.snapshot.session.harness, nativeId: activeBinding(resident)?.nativeId })
    return from
  }

  /**
   * Resume a relocated conversation's native session in its new folder now,
   * sending nothing, so a harness that no longer goes on there is found out
   * during the move and not at the person's next message. When it doesn't
   * resume, the conversation goes back to `from`, asleep as it was, and the
   * reason comes back for the caller to fork instead. One that hasn't
   * launched has nothing to resume.
   */
  async resumeMoved(id: string, from: string): Promise<string | undefined> {
    const resident = this.access.load(id)
    if (!resident) return "The conversation closed during the move."
    if (!launched(activeBinding(resident))) return undefined
    if (resident.snapshot.session.connection === "hibernated") await this.access.wake(resident)
    const { connection, status, error } = resident.snapshot.session
    if (connection === "connected" && status === "ready") return undefined
    const reason = error ?? `The harness didn't resume the session (${connection}, ${status}).`
    if (!resident.driver && !resident.waking && !resident.opening) {
      resident.snapshot = { ...resident.snapshot, session: { ...resident.snapshot.session, cwd: from, connection: "hibernated", status: "ready", error: undefined } }
      this.access.flush(resident)
    }
    hostWarn("residency", "a relocated conversation didn't resume", { conversation: id, harness: resident.snapshot.session.harness, error: reason })
    return reason
  }

  /** Before a native start: a conversation whose worktree was removed goes on in the project folder it was made from. */
  returnFromRemovedWorktree(resident: Resident): void {
    if (resident.driver || resident.opening || resident.closing) return
    const from = resident.snapshot.session.cwd
    const to = this.access.dependencies.projectFolderOfRemoved?.(from)
    if (!to) return
    const binding = activeBinding(resident)
    const driver = this.access.dependencies.driver(binding?.provider ?? "")
    if (binding?.nativeId && (driver?.resume.kind !== "native" || !driver.resume.elsewhere)) return
    resident.snapshot = { ...resident.snapshot, session: { ...resident.snapshot.session, cwd: to } }
    this.access.flush(resident)
    hostLog("residency", "conversation returned from a removed worktree", { conversation: resident.snapshot.session.id, from, to })
  }

  /** Whether `relocate` would move this conversation now, and if not, why. */
  relocation(id: string): Relocation {
    const resident = this.access.load(id)
    return resident ? this.relocates(resident) : { kind: "never", reason: "isn't open" }
  }

  /**
   * `relocation` once nothing in the conversation holds it any longer, or
   * after `ms` as it is then.
   */
  async relocationWithin(id: string, ms: number): Promise<Relocation> {
    const deadline = Date.now() + ms
    let relocation = this.relocation(id)
    while (relocation.kind === "wait" && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          this.waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, deadline - Date.now())
        this.waiters.add(done)
      })
      relocation = this.relocation(id)
    }
    return relocation
  }

  private relocates(resident: Resident): Relocation {
    const { session } = resident.snapshot
    const binding = activeBinding(resident)
    if (session.status === "closed") return { kind: "never", reason: "is closed" }
    if (!launched(binding)) {
      // Nothing of it is stored against its folder yet, so it starts wherever it is at its first launch.
      if (resident.driver) return { kind: "never", reason: "is starting its native session" }
    } else {
      const driver = this.access.dependencies.driver(binding.provider)
      if (driver?.resume.kind !== "native" || !driver.resume.elsewhere)
        return { kind: "never", reason: `runs on ${binding.provider}, which doesn't resume a session in another folder` }
    }
    const busy = this.access.moves.busy(resident)
    if (busy) return { kind: "wait", reason: busy }
    if (!resident.driver && !["hibernated", "disconnected"].includes(session.connection))
      return { kind: "never", reason: `is ${session.connection}` }
    return { kind: "now" }
  }

  /** Something that holds a move may have cleared: waiters look again, and so does the host. */
  changed(resident: Resident): void {
    for (const wake of this.waiters) wake()
    this.access.dependencies.settled?.(resident.snapshot.session.id)
  }
}

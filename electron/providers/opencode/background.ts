import type { OpenCodeEvent, ShellInfo } from "@opencode/client"
import { z } from "zod"

const ShellOwner = z.object({ sessionID: z.string() })
const ShellCall = z.object({ shellID: z.string() })

/**
 * The shells a conversation's sessions left running.
 *
 * Verified 2026-09-27 against opencode 2.0.1: the bash tool's
 * `background: true` runs its command as a native shell tagged with the
 * session, completes the call while the shell keeps running, and the shell
 * outlives both an interrupt and its server's exit. A foreground command's
 * shell exits before its call completes, so a shell still running when its
 * call completes is background work.
 */
export class OpenCodeShells {
  private readonly shells = new Map<string, { background: boolean }>()
  private readonly owns: (sessionID: string) => boolean

  constructor(owns: (sessionID: string) => boolean) {
    this.owns = owns
  }

  get running(): number {
    let count = 0
    for (const shell of this.shells.values()) if (shell.background) count++
    return count
  }

  /** The running count, when the event changes it. */
  observe(event: OpenCodeEvent): number | undefined {
    const before = this.running
    switch (event.type) {
      case "shell.created":
        if (event.data.info.status === "running" && this.owned(event.data.info)) this.shells.set(event.data.info.id, { background: false })
        break
      case "shell.exited":
        if (event.data.status !== "running") this.shells.delete(event.data.id)
        break
      case "shell.deleted":
        this.shells.delete(event.data.id)
        break
      case "session.tool.success":
      case "session.tool.failed": {
        const call = ShellCall.safeParse(event.data.metadata)
        const shell = call.success ? this.shells.get(call.data.shellID) : undefined
        if (shell) shell.background = true
        break
      }
      default:
        break
    }
    return this.running === before ? undefined : this.running
  }

  /** After missed events, drop what the native list no longer reports running. */
  reconcile(listed: readonly ShellInfo[]): number | undefined {
    const before = this.running
    const running = new Set(listed.filter((shell) => shell.status === "running").map((shell) => shell.id))
    for (const id of this.shells.keys()) if (!running.has(id)) this.shells.delete(id)
    return this.running === before ? undefined : this.running
  }

  /** Every shell in the list that belongs to the conversation and still runs, whatever started it. */
  ending(listed: readonly ShellInfo[]): ShellInfo[] {
    return listed.filter((shell) => shell.status === "running" && this.owned(shell))
  }

  private owned(shell: ShellInfo): boolean {
    const owner = ShellOwner.safeParse(shell.metadata)
    return owner.success && this.owns(owner.data.sessionID)
  }
}

import type { OpenCodeEvent, ShellInfo } from "@opencode/client"
import { z } from "zod"
import type { NativeAgentObservation } from "../../contracts/native-agents.js"

const ShellOwner = z.object({ sessionID: z.string() })
/** Undefined for any call but a shell's, rather than a failed `safeParse`, which builds an `Error`. */
const ShellCall = z.object({ shellID: z.string() }).optional().catch(undefined)

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
  private readonly shells = new Map<string, { background: boolean; command?: string }>()
  private readonly owns: (sessionID: string) => boolean
  /** Roster changes since the last `drain`: a shell that outlived its call, and its end. */
  private changed: NativeAgentObservation[] = []

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
        if (event.data.info.status === "running" && this.owned(event.data.info))
          this.shells.set(event.data.info.id, { background: false, command: event.data.info.command })
        break
      case "shell.exited":
        if (event.data.status !== "running") this.end(event.data.id, event.data.status === "killed"
          ? { kind: "canceled" }
          : { kind: "completed", ...(event.data.exit !== undefined && event.data.exit !== null && { summary: `Exited with code ${event.data.exit}` }) })
        break
      case "shell.deleted":
        this.end(event.data.id, { kind: "canceled" })
        break
      case "session.tool.success":
      case "session.tool.failed": {
        const call = ShellCall.parse(event.data.metadata)
        const shell = call ? this.shells.get(call.shellID) : undefined
        if (shell && !shell.background && call) {
          shell.background = true
          this.changed.push(this.entry(call.shellID, shell, { kind: "working" }))
        }
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
    for (const id of this.shells.keys()) if (!running.has(id)) this.end(id, { kind: "unknown", reason: "OpenCode no longer lists this shell" })
    return this.running === before ? undefined : this.running
  }

  /** The roster changes since the last call. */
  drain(): NativeAgentObservation[] {
    const changed = this.changed
    this.changed = []
    return changed
  }

  /** A shell that is still a conversation's background work, by id. */
  background(id: string): boolean {
    return this.shells.get(id)?.background === true
  }

  private end(id: string, state: NativeAgentObservation["state"]): void {
    const shell = this.shells.get(id)
    this.shells.delete(id)
    if (shell?.background) this.changed.push(this.entry(id, shell, state))
  }

  private entry(id: string, shell: { command?: string }, state: NativeAgentObservation["state"]): NativeAgentObservation {
    const command = shell.command?.slice(0, 8192)
    return {
      nativeId: id,
      title: (command || "Background shell").slice(0, 512),
      work: "command",
      ...(command && { detail: command }),
      background: true,
      stoppable: state.kind === "working",
      source: "opencode shell.created",
      state,
    }
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

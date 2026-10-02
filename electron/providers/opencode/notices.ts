import type { McpServer, OpenCodeEvent } from "@opencode/client"
import { event, mcpServerFailedEvent, type TranscriptEvent } from "@mako/sessions/events"

type Interruption = Extract<OpenCodeEvent, { type: "session.execution.interrupted" }>["data"]["reason"]

/**
 * Native events with nothing for the transcript: other clients' views and
 * terminals, configuration and install state, and session bookkeeping read
 * elsewhere. A notice is read from its inbox item, a skill from the prompt or
 * tool call that loaded it, a background shell from `OpenCodeShells`. A toast
 * is TUI chrome; the one OpenCode raises for an MCP server is its status.
 */
export const OPENCODE_IGNORED: ReadonlySet<string> = new Set<OpenCodeEvent["type"]>([
  "server.connected",
  "models-dev.refreshed",
  "credential.updated",
  "credential.switched",
  "integration.updated",
  "config.updated",
  "plugin.updated",
  "project.updated",
  "worktree.updated",
  "worktree.resolved",
  "reference.updated",
  "filesystem.changed",
  "vcs.branch.updated",
  "websearch.updated",
  "installation.updated",
  "installation.update-available",
  "mcp.resources.changed",
  "pty.created",
  "pty.updated",
  "pty.exited",
  "pty.deleted",
  "persistent-pty.added",
  "persistent-pty.removed",
  "tui.prompt.append",
  "tui.command.execute",
  "tui.toast.show",
  "tui.session.select",
  "shell.created",
  "shell.exited",
  "shell.deleted",
  "session.moved",
  "session.permissions.updated",
  "session.viewed",
  "session.deleted",
  "session.forked",
  "session.inbox.delivery.changed",
  "session.instructions.updated",
  "session.synthetic",
  "session.skill.activated",
  "session.shell.started",
  "session.shell.ended",
  "session.revert.staged",
  "session.revert.cleared",
  "session.revert.committed",
])

export function openCodeIgnores(event: OpenCodeEvent): boolean {
  return OPENCODE_IGNORED.has(event.type) || event.type.startsWith("rpc.")
}

const STOPPED = {
  shutdown: "OpenCode shut down",
  superseded: "a newer run took its place",
  inactivity: "the workspace was idle too long",
} satisfies Record<Exclude<Interruption, "user">, string>

/**
 * A turn OpenCode ended on its own, or a client other than Mako stopped
 * (OpenCode's service is shared, and every client's interrupt reads "user").
 * One stopped from Mako needs no marker.
 */
export function openCodeStopped(reason: Interruption, requested: boolean): TranscriptEvent | undefined {
  if (reason !== "user") return event("Stopped by OpenCode", STOPPED[reason])
  return requested ? undefined : event("Stopped outside Mako", "another OpenCode client interrupted this turn")
}

type McpStatus = McpServer["status"]["status"]

/**
 * MCP server failures, once each. A server that keeps failing is one marker;
 * one that recovers and fails again is another.
 */
export class OpenCodeMcpHealth {
  private readonly reported = new Map<string, McpStatus>()

  observe(servers: readonly McpServer[]): TranscriptEvent[] {
    return servers.flatMap(({ name, status: state }) => {
      if (state.status === "failed") return this.report(name, state.status, state.error)
      if (state.status === "needs_auth") return this.report(name, state.status, "sign-in required")
      if (state.status === "connected" || state.status === "disabled") this.reported.delete(name)
      return []
    })
  }

  /** A server OpenCode refused to add. */
  failed(name: string, error: string): TranscriptEvent[] {
    return this.report(name, "failed", error)
  }

  private report(name: string, status: McpStatus, error: string): TranscriptEvent[] {
    if (this.reported.get(name) === status) return []
    this.reported.set(name, status)
    return [mcpServerFailedEvent(name, error)]
  }
}

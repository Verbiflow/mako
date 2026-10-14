import { readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parse as parseToml } from "smol-toml"
import { z } from "zod"
import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk"
import type { NativeApprovalDecision, NativeApprovalIdentity } from "../../contracts/approval-response.js"
import type { AcpApprovalObserver } from "../acp-source.js"
import { approvalAnswerDigest } from "../approval-evidence.js"
import { RetainedApprovalDecisions, readRetainedApprovalDecisions } from "../retained-approval-decisions.js"

/**
 * Which answer Grok applied to a shell command's approval, read from Grok's
 * own records (grok 1.0.46, checked against a scripted model):
 *
 * - "Yes, and don't ask again" adds the exact command to
 *   `allowed_bash_commands` in `<GROK_HOME>/sessions/<project>/permission.toml`
 *   before the command runs; "Yes, proceed" runs it and saves nothing.
 * - "No, and don't ask again" adds it to `disallowed_bash_commands`, and the
 *   failed tool call says "excluded `<command>` from future runs"; "No"
 *   fails the call with "User rejected" and saves nothing.
 *
 * So the command running or failing, with the file changed or not, is the
 * native evidence of the choice, and nothing is inferred from the answer
 * Mako sent. Edit and MCP approvals keep their grants in memory and stay
 * submission-only; a command Grok already saved never asks.
 */

/** The four answers Grok offers for a shell command, by its own option ids. */
const SHELL_OPTIONS = ["always-allow", "allow-once", "reject-once", "reject-always"] as const
type ShellOption = (typeof SHELL_OPTIONS)[number]
const Command = z.object({ command: z.string().min(1).max(16 * 1024) })
const Saved = z.object({ allowed_bash_commands: z.array(z.string()).default([]), disallowed_bash_commands: z.array(z.string()).default([]) })
const Text = z.object({ content: z.object({ type: z.literal("text"), text: z.string() }) })

interface Pending {
  identity: NativeApprovalIdentity
  command: string
  /** What the file held when Grok asked, so only a change made by this answer counts. */
  before: z.infer<typeof Saved>
  settled: boolean
}

/** Grok's own folder for a project's sessions: its real path, every `/` escaped. */
export async function grokPermissionFile(grokHome: string, project: string): Promise<string> {
  return join(grokHome, "sessions", encodeURIComponent(await realpath(project).catch(() => project)), "permission.toml")
}

export class GrokApprovalObserver implements AcpApprovalObserver {
  private readonly retained: RetainedApprovalDecisions
  private readonly pending = new Map<string, Pending | null>()
  private readonly previous = new Set<string>()
  private readonly publish: (decision: NativeApprovalDecision) => void
  private readonly file: string
  private closed = false

  constructor(input: { root: string; file: string; previous: readonly NativeApprovalIdentity[]; publish(decision: NativeApprovalDecision): void }) {
    this.retained = new RetainedApprovalDecisions(input.root)
    this.file = input.file
    this.publish = input.publish
    for (const identity of input.previous) this.previous.add(key(identity.sessionId, identity.requestId))
  }

  async identify(request: RequestPermissionRequest): Promise<NativeApprovalIdentity | undefined> {
    const ids = request.options.map((option) => option.optionId)
    const command = Command.safeParse(request.toolCall.rawInput).data?.command
    if (this.closed || !command || ids.length !== SHELL_OPTIONS.length || !SHELL_OPTIONS.every((id) => ids.includes(id))) return
    const id = key(request.sessionId, request.toolCall.toolCallId)
    // A tool call asking twice, or one answered before this process, can't be joined to one answer.
    if (this.previous.has(id) || this.pending.has(id)) { this.pending.set(id, null); return }
    if (this.pending.size >= 2000) return
    const identity = { scope: this.retained.scope, sessionId: request.sessionId, requestId: request.toolCall.toolCallId }
    this.pending.set(id, { identity, command, before: await this.saved(), settled: false })
    return identity
  }

  observe({ sessionId, update }: SessionNotification): void {
    if (update.sessionUpdate !== "tool_call_update" || !update.status) return
    const pending = this.pending.get(key(sessionId, update.toolCallId))
    if (!pending || pending.settled) return
    if (update.status === "failed") {
      pending.settled = true
      const text = (update.content ?? []).flatMap((item) => Text.safeParse(item).data?.content.text ?? []).join("\n")
      void this.settle(pending, text.includes(`excluded \`${pending.command}\` from future runs`) ? "reject-always" : text.startsWith("User rejected") ? "reject-once" : null)
    } else if (update.status === "in_progress" || update.status === "completed") {
      pending.settled = true
      void this.allowed(pending)
    }
  }

  /** Grok saves an always-allowed command as it answers; a short wait covers the write landing after the run starts. */
  private async allowed(pending: Pending): Promise<void> {
    for (const wait of [0, 250, 750]) {
      await delay(wait)
      const saved = await this.saved()
      if (saved.allowed_bash_commands.includes(pending.command) && !pending.before.allowed_bash_commands.includes(pending.command))
        return this.settle(pending, "always-allow")
    }
    return this.settle(pending, "allow-once")
  }

  private async settle(pending: Pending, option: ShellOption | null): Promise<void> {
    if (!option || this.closed) return
    if (option === "reject-always") {
      // The words say so; the file must agree before it counts.
      const saved = await this.saved()
      if (!saved.disallowed_bash_commands.includes(pending.command) || pending.before.disallowed_bash_commands.includes(pending.command)) return
    }
    try {
      this.publish(await this.retained.record({ identity: pending.identity, answerDigest: approvalAnswerDigest({ kind: "choice", optionId: option }), observedAt: Date.now() }))
    } catch {
      // Storage refused or the observer closed: the answer stays unconfirmed rather than guessed.
    }
  }

  private async saved(): Promise<z.infer<typeof Saved>> {
    try { return Saved.parse(parseToml(await readFile(this.file, "utf8"))) }
    catch { return { allowed_bash_commands: [], disallowed_bash_commands: [] } }
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.pending.clear()
    await this.retained.close()
  }
}

/** The decisions an earlier process retained for these occurrences, published before any new one. */
export function readGrokApprovalDecisions(root: string, previous: readonly NativeApprovalIdentity[]): Promise<NativeApprovalDecision[]> {
  return readRetainedApprovalDecisions(root, previous)
}

function key(sessionId: string, requestId: string): string {
  return JSON.stringify([sessionId, requestId])
}

import type { HookCallback, ModelUsage, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { JsonValue } from "../../codex-app-json.js"
import { decoded, decodedNotices, type Decoded } from "../../contracts/native-decoding.js"
import type { LiveSessionCommand, LiveSessionState, LiveSessionUsage } from "../../contracts/providers-acp.js"
import { claudeRateLimitWindow } from "./accounts.js"
import { claudeMessageKind } from "./sdk-message-kinds.js"
import { ClaudeNotices } from "./sdk-notices.js"
import { ClaudeProjection } from "./sdk-projection.js"

/**
 * Claude Agent SDK messages as Mako's shared decoded events. Pure: it reads
 * the message, the session view it was given and its own assembly state
 * (streamed blocks, notices said once, the last request's context), so a
 * recorded session decodes the same every time
 * (`scripts/fixtures/native-decoding/claude`). The driver keeps what
 * answers Claude or reads its files: receipts, permissions, the transcript
 * on disk, subagents and how a turn ends.
 */

/** The session the decoder reads; the driver's live state is one. */
export interface ClaudeDecoderView {
  readonly state: Pick<LiveSessionState, "currentMode" | "usage" | "settings" | "commands" | "backgroundTasks">
}

export class ClaudeDecoder {
  private readonly projection = new ClaudeProjection()
  private readonly notices: ClaudeNotices
  private readonly view: ClaudeDecoderView
  /** The model and context of the main loop's latest request, for the usage its turn's result reports. */
  private lastCall?: { model: string; tokens: number }
  /** Commands `init` said belong to a terminal; a later command list leaves them out too. */
  private terminalCommands = new Set<string>()

  constructor(view: ClaudeDecoderView, now: () => number = Date.now) {
    this.view = view
    this.notices = new ClaudeNotices(now)
  }

  /** The PostCompact hook, whose summary names the compaction boundary that follows. */
  get hook(): HookCallback {
    return this.notices.hook
  }

  /** A turn opens: what earlier turns streamed can no longer be withdrawn. */
  startTurn(): void {
    this.projection.reset()
  }

  decode(message: SDKMessage): Decoded<never>[] {
    const out: Decoded<never>[] = []
    const notices = this.notices.decode(message)
    if (notices) out.push(...decodedNotices(notices, message.uuid))
    else out.push(decoded.unknown(claudeMessageKind(message), raw(message)))
    out.push(...this.session(message))
    if (message.type === "rate_limit_event") {
      const window = claudeRateLimitWindow(message.rate_limit_info)
      if (window) out.push(decoded.usage([window]))
    }
    for (const update of this.projection.withdraw(message)) out.push(decoded.update(update))
    for (const update of this.projection.project(message)) out.push(decoded.update(update))
    if (message.type === "system" && message.subtype === "init") {
      const options = { ...this.view.state.settings?.options }
      if (message.effort) options.effort = message.effort
      if (message.fast_mode_state) options.fast = message.fast_mode_state !== "off"
      this.terminalCommands = new Set(message.terminal_slash_commands ?? [])
      const described = new Map(this.view.state.commands?.map((command) => [command.name, command]))
      out.push(decoded.state({
        nativeId: message.session_id,
        currentMode: message.permissionMode,
        commands: (message.slash_commands ?? [])
          .filter((name) => !this.terminalCommands.has(name))
          .map((name) => described.get(name) ?? { name }),
        settings: { ...this.view.state.settings, model: message.model, options },
      }))
    }
    return out
  }

  /** Claude's own reports that move the session's state outside a turn's content. */
  private session(message: SDKMessage): Decoded<never>[] {
    const { state } = this.view
    if (message.type === "assistant") {
      const { model, usage } = message.message
      if (!message.parent_tool_use_id && model !== "<synthetic>")
        this.lastCall = { model, tokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) + usage.output_tokens }
      return []
    }
    if (message.type === "result") {
      const size = this.lastCall && contextWindow(message.modelUsage, this.lastCall.model)
      return this.lastCall && size
        ? this.usage({ used: this.lastCall.tokens, size,
            cost: message.total_cost_usd > 0 ? { amount: message.total_cost_usd, currency: "USD" } : state.usage?.cost })
        : []
    }
    if (message.type === "conversation_reset") {
      this.lastCall = undefined
      return [decoded.state({ nativeId: message.new_conversation_id, usage: undefined })]
    }
    if (message.type !== "system") return []
    switch (message.subtype) {
      case "status":
        return message.permissionMode && message.permissionMode !== state.currentMode
          ? [decoded.state({ currentMode: message.permissionMode })]
          : []
      case "compact_boundary": {
        this.lastCall = undefined
        const after = message.compact_metadata.post_tokens
        return after !== undefined && state.usage ? this.usage({ ...state.usage, used: after }) : []
      }
      case "commands_changed":
        return [decoded.state({
          commands: message.commands
            .filter((command) => !this.terminalCommands.has(command.name))
            .map((command): LiveSessionCommand => ({ name: command.name, description: command.description || undefined, hint: command.argumentHint || undefined })),
        })]
      case "background_tasks_changed": {
        const running = message.tasks.filter((task) => !task.ambient).length
        return running !== (state.backgroundTasks ?? 0) ? [decoded.state({ backgroundTasks: running })] : []
      }
      default:
        return []
    }
  }

  private usage(usage: LiveSessionUsage): Decoded<never>[] {
    const held = this.view.state.usage
    return held?.used === usage.used && held.size === usage.size && held.cost?.amount === usage.cost?.amount
      ? []
      : [decoded.state({ usage })]
  }
}

/** The answering model's window. Usage can key it with a suffix the reply's model id lacks (`[1m]`). */
function contextWindow(models: Record<string, ModelUsage>, model: string): number | undefined {
  const usage = Object.hasOwn(models, model)
    ? models[model]
    : Object.entries(models).find(([name]) => name.startsWith(model))?.[1]
  return usage?.contextWindow || undefined
}

/** A message this SDK doesn't declare, kept whole for the unknown-record log. */
function raw(message: SDKMessage): JsonValue {
  return JSON.parse(JSON.stringify(message))
}

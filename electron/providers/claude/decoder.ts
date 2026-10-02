import type { HookCallback, ModelUsage, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { JsonValue } from "../../codex-app-json.js"
import { decoded, decodedNotices, type Decoded } from "../../contracts/native-decoding.js"
import type { LiveSessionCommand, LiveSessionState, TokenCounts } from "../../contracts/providers-acp.js"
import { SessionUsage, type UsageObservation } from "../../session-usage.js"
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
  /** The main loop's latest model, whose window the turn's result reports. */
  private lastModel?: string
  private readonly meter = new SessionUsage()
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
      if (message.parent_tool_use_id || model === "<synthetic>") return []
      this.lastModel = model
      return this.usage({ kind: "call", tokens: {
        input: usage.input_tokens,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        output: usage.output_tokens,
      } })
    }
    if (message.type === "result") {
      const size = this.lastModel && contextWindow(message.modelUsage, this.lastModel)
      const observations: UsageObservation[] = Object.keys(message.modelUsage).length
        ? [{ kind: "total", tokens: sessionTokens(message.modelUsage) }]
        : []
      if (size) observations.push({ kind: "window", size })
      if (message.total_cost_usd > 0) observations.push({ kind: "cost", amount: message.total_cost_usd, currency: "USD" })
      return this.usage(...observations)
    }
    if (message.type === "conversation_reset") {
      this.lastModel = undefined
      this.meter.observe({ kind: "reset" })
      return [decoded.state({ nativeId: message.new_conversation_id, usage: this.meter.current })]
    }
    if (message.type !== "system") return []
    switch (message.subtype) {
      case "status":
        return message.permissionMode && message.permissionMode !== state.currentMode
          ? [decoded.state({ currentMode: message.permissionMode })]
          : []
      case "compact_boundary":
        return this.usage({ kind: "compacted", after: message.compact_metadata.post_tokens })
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

  private usage(...observations: UsageObservation[]): Decoded<never>[] {
    const usage = this.meter.observe(...observations)
    return usage ? [decoded.state({ usage })] : []
  }
}

/** Every model the session used, background ones too: what the session has spent. */
function sessionTokens(models: Record<string, ModelUsage>): TokenCounts {
  const tokens: TokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  for (const usage of Object.values(models)) {
    tokens.input += usage.inputTokens
    tokens.cacheRead += usage.cacheReadInputTokens
    tokens.cacheWrite += usage.cacheCreationInputTokens
    tokens.output += usage.outputTokens
    if (usage.thinkingTokens) tokens.reasoning = (tokens.reasoning ?? 0) + usage.thinkingTokens
  }
  return tokens
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

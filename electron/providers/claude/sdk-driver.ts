import { ClaudeAgents } from "./sdk-agents.js"
import { randomUUID } from "node:crypto"
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { SessionSettings } from "@mako/sessions/settings"
import type { LiveSessionMode, LiveSessionState } from "../../shared.js"
import type {
  ProviderLiveDriver,
  ProviderStartOptions,
  ProviderSteerResult,
} from "../live-driver.js"
import {
  ClaudeInput,
  ClaudeModeSchema,
  ClaudeTuningSchema,
  claudeInputContent,
} from "./input.js"
import { ClaudeProjection } from "./sdk-projection.js"
import { spawnClaudeProcess } from "./sdk-process.js"
import { ClaudePermissions } from "./sdk-permissions.js"
import { ClaudeTranscript } from "./sdk-transcript.js"

/** Claude's permission modes, placed on the shared access ladder. */
const CLAUDE_MODES: LiveSessionMode[] = [
  { id: "default", name: "Ask for approval", access: "ask", enforcement: "provider" },
  { id: "acceptEdits", name: "Accept edits", access: "edits", enforcement: "provider" },
  { id: "plan", name: "Plan", access: "plan", enforcement: "provider" },
  { id: "dontAsk", name: "Deny unapproved tools", access: "deny", enforcement: "provider" },
  { id: "auto", name: "Automatic approval review", access: "auto", enforcement: "provider" },
  { id: "bypassPermissions", name: "Bypass permissions", access: "full", enforcement: "provider" },
]

type ClaudeQuery = Pick<
  Query,
  | typeof Symbol.asyncIterator
  | "initializationResult"
  | "setModel"
  | "applyFlagSettings"
  | "setPermissionMode"
  | "interrupt"
  | "close"
>
interface Receipt {
  resolve(result: ProviderSteerResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
interface Live {
  state: LiveSessionState
  query: ClaudeQuery
  input: ClaudeInput
  agents: ClaudeAgents
  projection: ClaudeProjection
  permissions: ClaudePermissions
  transcript: ClaudeTranscript
  emit: NonNullable<ProviderStartOptions["emit"]>
  receipts: Map<string, Receipt>
  closed: boolean
  steered: boolean
  finishing: boolean
  exited(): Promise<void>
}
export interface ClaudeSdkDependencies {
  available(): boolean
  configure(cwd: string, options: ProviderStartOptions): Promise<Options>
  query(input: {
    prompt: AsyncIterable<SDKUserMessage>
    options: Options
  }): ClaudeQuery
  interruptTimeoutMs?: number
  receiptTimeoutMs?: number
}

function update(live: Live, patch: Partial<LiveSessionState>): void {
  live.state = { ...live.state, ...patch }
  live.emit({ type: "acp-session", session: live.state })
}

function stop(live: Live): void {
  live.closed = true
  live.input.close()
  live.permissions.close()
  live.query.close()
  for (const receipt of live.receipts.values()) {
    clearTimeout(receipt.timer)
    receipt.reject(
      new Error(
        "Claude disconnected before confirming steering delivery. Do not resend automatically."
      )
    )
  }
  live.receipts.clear()
}

function acknowledge(live: Live, message: SDKMessage): void {
  const ids = new Set<string>()
  if (message.type === "user" && message.uuid) ids.add(message.uuid)
  if ("user_message_uuid" in message && message.user_message_uuid)
    ids.add(message.user_message_uuid)
  if ("user_message_uuids" in message)
    for (const id of message.user_message_uuids ?? []) ids.add(id)
  for (const id of ids) {
    const receipt = live.receipts.get(id)
    if (!receipt) continue
    clearTimeout(receipt.timer)
    live.receipts.delete(id)
    receipt.resolve({ kind: "accepted" })
  }
}

async function pump(live: Live): Promise<void> {
  try {
    for await (const message of live.query) {
      if (live.closed) return
      acknowledge(live, message)
      live.transcript.observe(message)
      const agent = live.agents.project(message)
      if (agent) live.emit({ type: "acp-agent", id: live.state.id, agent })
      const updates = live.projection.project(message)
      if (updates.length)
        live.emit({ type: "acp-updates", id: live.state.id, updates })
      if (message.type === "system" && message.subtype === "init") {
        const options = { ...live.state.settings?.options }
        if (message.effort) options.effort = message.effort
        if (message.fast_mode_state)
          options.fast = message.fast_mode_state !== "off"
        update(live, {
          nativeId: message.session_id,
          currentMode: message.permissionMode,
          settings: {
            ...live.state.settings,
            model: message.model,
            options,
          },
        })
      }
      if (message.type !== "result" || live.state.status !== "running") continue
      if (live.steered && message.terminal_reason === "aborted_streaming")
        continue
      if ((message.queued_turn_count ?? 0) > 0) continue
      live.steered = false
      live.finishing = true
      live.permissions.close()
      const nativeForkId = message.is_error
        ? undefined
        : await live.transcript.forkPoint(live.state.nativeId)
      if (live.closed) return
      update(live, {
        nativePath: live.transcript.path,
        nativeForkId,
        status: message.is_error ? "failed" : "ready",
        lastStop: message.is_error ? "failed" : "completed",
        error:
          message.subtype === "success"
            ? undefined
            : message.errors.join("\n").slice(0, 2000),
      })
      live.finishing = false
    }
    if (!live.closed) throw new Error("Claude Code closed its SDK stream")
  } catch (error) {
    if (live.closed) return
    stop(live)
    update(live, {
      status: "failed",
      connection: "disconnected",
      error: error instanceof Error ? error.message : String(error),
      lastStop: "failed",
    })
  }
}

async function tune(live: Live, settings?: SessionSettings): Promise<void> {
  if (!settings) return
  const tuning = ClaudeTuningSchema.parse(settings.options ?? {})
  if (
    tuning.agentTeams !== undefined &&
    tuning.agentTeams !== live.state.settings?.options?.agentTeams
  )
    throw new Error("Change agent teams by starting a new Claude session")
  if (settings.model && settings.model !== live.state.settings?.model)
    await live.query.setModel(settings.model)
  if (tuning.effort !== undefined || tuning.fast !== undefined)
    await live.query.applyFlagSettings({
      effortLevel: tuning.effort,
      fastMode: tuning.fast,
    })
  live.state = {
    ...live.state,
    settings: {
      ...live.state.settings,
      ...settings,
      options: { ...live.state.settings?.options, ...settings.options },
    },
  }
}

export function createClaudeSdkDriver(
  dependencies: ClaudeSdkDependencies
): ProviderLiveDriver {
  const sessions = new Map<string, Live>()
  const starting = new Map<string, symbol>()
  function requireLive(id: string): Live {
    const live = sessions.get(id)
    if (!live || live.closed)
      throw new Error("This Claude session is disconnected")
    return live
  }
  return {
    provider: "claude",
    observesNativeAgents: true,
    canResume: true,
    forkPoint: "checkpoint",
    steering: "step",
    modes: CLAUDE_MODES,
    available: () => dependencies.available(),
    async start(cwd, options) {
      if (!options.emit) throw new Error("A live event receiver is required")
      const conversationId = options.conversationId
      if (
        starting.has(options.conversationId) ||
        (sessions.has(options.conversationId) &&
          !sessions.get(options.conversationId)?.closed)
      )
        throw new Error("This Claude binding is already connected")
      const generation = Symbol()
      starting.set(options.conversationId, generation)
      let config: Options
      try {
        config = await dependencies.configure(cwd, options)
        if (starting.get(options.conversationId) !== generation)
          throw new Error("Claude was closed while configuring")
      } finally {
        if (starting.get(options.conversationId) === generation)
          starting.delete(options.conversationId)
      }
      const input = new ClaudeInput()
      const transcript = new ClaudeTranscript()
      const permissions = new ClaudePermissions(
        options.conversationId,
        options.emit
      )
      let exited = Promise.resolve()
      const query = dependencies.query({
        prompt: input,
        options: {
          ...config,
          hooks: {
            ...config.hooks,
            SessionStart: [
              ...(config.hooks?.SessionStart ?? []),
              { hooks: [transcript.hook] },
            ],
            Stop: [...(config.hooks?.Stop ?? []), { hooks: [transcript.hook] }],
          },
          spawnClaudeCodeProcess: (options) => {
            const child = spawnClaudeProcess(options, conversationId)
            exited = new Promise<void>((resolve) => {
              child.once("exit", () => resolve())
              child.once("error", () => resolve())
            })
            return child
          },
          canUseTool: permissions.tool,
          onElicitation: permissions.elicitation,
        },
      })
      const live: Live = {
        query,
        exited: () => exited,
        input,
        permissions,
        transcript,
        emit: options.emit,
        projection: new ClaudeProjection(),
        agents: new ClaudeAgents(),
        receipts: new Map(),
        closed: false,
        steered: false,
        finishing: false,
        state: {
          id: options.conversationId,
          harness: "claude",
          cwd,
          title: options.title,
          nativeId: options.fork
            ? options.conversationId
            : (options.resume ?? options.conversationId),
          status: "starting",
          connection: "starting",
          modes: CLAUDE_MODES,
          currentMode: null,
          configOptions: [],
          settings: options.tuning,
        },
      }
      sessions.set(live.state.id, live)
      void pump(live)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          query.initializationResult(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Claude SDK initialization timed out")),
              20_000
            )
          }),
        ])
        if (live.closed)
          throw new Error("Claude disconnected during initialization")
        update(live, {
          status: "ready",
          connection: "connected",
          nativePath: transcript.path,
        })
        return live.state
      } catch (error) {
        stop(live)
        throw error
      } finally {
        clearTimeout(timer)
      }
    },
    async prompt(id, text, attachments, settings) {
      const live = requireLive(id)
      if (live.state.status === "running")
        throw new Error("Claude is already working")
      const content = await claudeInputContent(text, attachments)
      await tune(live, settings)
      const current = requireLive(id)
      if (current !== live || current.state.status === "running")
        throw new Error("Claude changed while preparing the prompt")
      const uuid = randomUUID()
      live.projection.reset()
      live.transcript.reset()
      update(live, {
        status: "running",
        nativeForkId: undefined,
        nativeRunId: uuid,
        lastStop: undefined,
        error: undefined,
      })
      live.emit({ type: "acp-update", id, update: { kind: "user", text } })
      live.input.send({
        type: "user",
        uuid,
        session_id: live.state.nativeId,
        parent_tool_use_id: null,
        message: { role: "user", content },
      })
    },
    async steer(id, input) {
      const live = requireLive(id)
      const content = await claudeInputContent(input.text, input.attachments)
      if (
        live.closed ||
        live.finishing ||
        live.state.status !== "running" ||
        live.state.nativeRunId !== input.expectedRunId
      )
        return {
          kind: "not-accepted",
          reason: "The Claude turn has already changed",
        }
      const uuid = randomUUID()
      const receipt = new Promise<ProviderSteerResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          live.receipts.delete(uuid)
          reject(
            new Error(
              "Claude has not confirmed steering delivery. Do not resend automatically."
            )
          )
        }, dependencies.receiptTimeoutMs ?? 120_000)
        live.receipts.set(uuid, { resolve, reject, timer })
      })
      try {
        live.input.send({
          type: "user",
          uuid,
          session_id: live.state.nativeId,
          parent_tool_use_id: null,
          priority: "now",
          message: { role: "user", content },
        })
        live.steered = true
      } catch (error) {
        const pending = live.receipts.get(uuid)
        if (pending) {
          clearTimeout(pending.timer)
          live.receipts.delete(uuid)
          pending.reject(
            error instanceof Error ? error : new Error(String(error))
          )
        }
      }
      return receipt
    },
    async compact(id) {
      const live = requireLive(id)
      if (live.state.status === "running")
        throw new Error("Wait for Claude to finish before compacting")
      const uuid = randomUUID()
      update(live, {
        status: "running",
        nativeRunId: uuid,
        lastStop: undefined,
        error: undefined,
      })
      live.input.send({
        type: "user",
        uuid,
        session_id: live.state.nativeId,
        parent_tool_use_id: null,
        message: { role: "user", content: "/compact" },
      })
    },
    async permission(id, requestId, response) {
      requireLive(id).permissions.respond(requestId, response)
    },
    async setMode(id, modeId) {
      const live = requireLive(id)
      const mode = ClaudeModeSchema.parse(modeId)
      await live.query.setPermissionMode(mode)
      update(live, { currentMode: mode })
    },
    async cancel(id) {
      const live = requireLive(id)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          live.query.interrupt(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Claude interrupt timed out; the process was closed"
                  )
                ),
              dependencies.interruptTimeoutMs ?? 20_000
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
        // Query.interrupt can leave SDK-queued input behind. Closing its process
        // makes Stop definitive; the next prompt resumes the same native session.
        stop(live)
        await live.exited()
        update(live, {
          status: "ready",
          connection: "disconnected",
          lastStop: "interrupted",
        })
      }
    },
    async close(id) {
      starting.delete(id)
      const live = sessions.get(id)
      if (!live) return
      stop(live)
      sessions.delete(id)
      await live.exited()
    },
  }
}

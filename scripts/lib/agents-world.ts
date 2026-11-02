import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { ThreadPage, ThreadRef } from "@mako/sessions"
import { HostJobs } from "@mako/host/base/host-jobs"
import { ACCESS_TIERS, accessModeId, type AccessTier } from "@mako/host/contracts/access"
import type { AgentCaller, TreeBudget } from "@mako/host/contracts/agents"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { LiveSessionMode, LiveSessionState } from "@mako/host/contracts/providers-acp"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { Agents, type AgentsDeps } from "@mako/host/conversations/agents"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { ThreadStore } from "@mako/host/threads/store"
import { fixtureResume, noCapabilities } from "../fixtures/driver-capabilities.ts"

/** The six harnesses, as a lead or a child runs on them here: each a scripted driver, two of them steering at the next step as Claude's and OpenCode's do. */
export const HARNESSES = ["claude", "codex", "cursor", "grok", "opencode", "devin"] as const
const STEERS_AT_STEP = new Set<string>(["claude", "opencode"])
/** Every access tier, as a harness that offers Mako's modes lists them. */
const MODES = ACCESS_TIERS.map((info) => ({ id: accessModeId(info.tier), name: info.label, access: info.tier }))

/** One turn a scripted model takes: what it was sent, and who it is. */
export interface ScriptedTurn {
  world: AgentsWorld
  conversation: string
  harness: string
  text: string
  /** Its Session, the caller its tools speak for. */
  caller: AgentCaller
}

/** What a scripted model does with a turn: its reply, once whatever it calls has answered. `hold` keeps the turn running until it resolves. */
export type Script = (turn: ScriptedTurn) => Promise<string> | string

export interface WorldOptions {
  root: string
  script: Script
  budget?: TreeBudget
  /** Test override for the wait before Mako continues a turn its exit cut short. */
  autoContinueDelayMs?: number
  /** Runs as a launch applies its mode: after its harness started, before its first message is sent. */
  launching?: (conversation: string) => Promise<void> | void
  /** Every steer is refused, as a harness whose turn moved on refuses one. */
  refuseSteers?: true
  /** A harness's own modes, as its real driver declares them, in place of Mako's tier ids. */
  ladders?: Partial<Record<string, readonly LiveSessionMode[]>>
}

/**
 * A host as far as children go, with every harness a scripted model: the
 * real Thread store, `LiveConversations` and `Agents`, wired as the host
 * wires them, and a driver per harness whose turns the script answers. A
 * restart closes the host as Mako's exit does and opens a new one on the
 * same store and journals.
 */
export class AgentsWorld {
  readonly root: string
  readonly options: WorldOptions
  /** Every prompt a driver was sent, in order: a turn lost or run twice shows here. */
  readonly prompts: { conversation: string; harness: string; text: string; at: number }[] = []
  readonly steers: { conversation: string; text: string; at: number }[] = []
  readonly events: HostEvent[] = []
  store!: ThreadStore
  live!: LiveConversations
  agents!: Agents
  jobs!: HostJobs
  private running = new Set<Promise<unknown>>()
  private holds = new Map<string, () => void>()

  constructor(options: WorldOptions) {
    this.root = options.root
    this.options = options
    mkdirSync(join(options.root, "journals"), { recursive: true })
    this.open()
  }

  /** Opens the host: the store, the conversations and the engine, and what the last host left. */
  open(): void {
    this.store = new ThreadStore(join(this.root, "threads.sqlite"), { now: () => Date.now() })
    this.jobs = new HostJobs()
    const drivers = new Map<string, ProviderLiveDriver>(HARNESSES.map((harness) => [harness, this.driver(harness)]))
    this.live = new LiveConversations({
      appPath: this.root,
      root: join(this.root, "journals"),
      driver: (provider) => drivers.get(provider),
      history: async () => null,
      emit: (event) => this.events.push(event),
      threads: this.store,
      agents: () => this.agents,
      settled: (id) => this.agents?.moved(id),
      autoContinueDelayMs: this.options.autoContinueDelayMs ?? 10,
      resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    })
    const deps: AgentsDeps = {
      store: () => this.store,
      catalog: emptyCatalog(),
      jobs: this.jobs,
      live: this.live,
      startLive: async (harness, cwd, options) => {
        await this.live.start(harness, cwd, options)
      },
      harnesses: () => HARNESSES,
      runs: () => false,
      harnessLabel: (harness) => harness[0]!.toUpperCase() + harness.slice(1),
      modes: (harness) => drivers.get(harness)?.modes,
      ...(this.options.budget && { budget: this.options.budget }),
    }
    this.agents = new Agents(deps)
    this.agents.resume()
    this.live.continueRestarted()
  }

  /** Closes the host as Mako's exit does: running turns are cut short and left for the next host, their scripts never answering. */
  async close(): Promise<void> {
    this.holds.clear()
    this.running.clear()
    await this.live.closeForExit()
    await this.live.stop()
    this.agents.dispose()
    this.jobs.stop()
    this.store.close()
  }

  async restart(): Promise<void> {
    await this.close()
    this.open()
  }

  /** A top-level conversation on `harness` at `access`: a lead once it starts a child. */
  async lead(harness: string, access: AccessTier = "auto"): Promise<{ conversation: string; caller: AgentCaller }> {
    const conversation = randomUUID()
    const modeId = this.options.ladders?.[harness]?.find((mode) => mode.access === access)?.id ?? accessModeId(access)
    await this.live.start(harness, this.root, { conversationId: conversation, title: `${harness} lead`, modeId })
    return { conversation, caller: this.caller(conversation) }
  }

  caller(conversation: string): AgentCaller {
    const session = this.store.journalPlacement(conversation)?.session
    if (!session) throw new Error(`${conversation} has no Session`)
    return { kind: "agent", session }
  }

  /** The person sends `text` to a conversation. */
  say(conversation: string, text: string): string {
    const request = randomUUID()
    this.live.submit(conversation, request, text, [])
    return request
  }

  /** Lets a held turn end (`hold`). */
  release(conversation: string): void {
    this.holds.get(conversation)?.()
  }

  /** Holds a conversation's current turn until `release`: a script awaits this to stay running. */
  hold(conversation: string): Promise<void> {
    return new Promise((resolve) => this.holds.set(conversation, () => {
      this.holds.delete(conversation)
      resolve()
    }))
  }

  /** Every turn has ended and, unless `wakes` is "ignore", no wake is pending, for `quietMs` in a row. */
  async settle(quietMs = 2_600, timeoutMs = 20_000, wakes: "wait" | "ignore" = "wait"): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let quietSince = Date.now()
    let seen = this.prompts.length
    while (Date.now() - quietSince < quietMs) {
      if (Date.now() > deadline) throw new Error(`Still busy after ${timeoutMs} ms: ${this.running.size} turns, ${this.agents.wakes.pending()} wakes`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const busy = this.running.size > 0 || (wakes === "wait" && this.agents.wakes.pending() > 0) || this.live.lifecycleWork().length > 0
      if (busy || this.prompts.length !== seen) {
        seen = this.prompts.length
        quietSince = Date.now()
      }
    }
  }

  private driver(harness: string): ProviderLiveDriver {
    const modes = this.options.ladders?.[harness] ?? MODES
    const state = (id: string, patch: Partial<LiveSessionState> = {}): LiveSessionState => ({
      id, nativeId: `native-${id}`, nativePath: join(this.root, "native", id), harness, cwd: this.root,
      status: "ready", connection: "connected", modes: [...modes], currentMode: null, configOptions: [], ...patch,
    })
    return {
      ...noCapabilities,
      modes,
      approvalEvidence: { kind: "submission-only", reason: "Scripted model" },
      launchEnvironment: { kind: "unavailable", reason: "Scripted model" },
      nativeIdentity: { kind: "unavailable", reason: "Scripted model" },
      nativeExclusion: NO_NATIVE_EXCLUSION,
      nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
      planning: { via: "setting", option: "plan", proposal: "Scripted model", feedback: { kind: "next-message", reason: "Scripted model" } },
      backgroundStop: { kind: "ends-with-turn", evidence: "Scripted model" },
      turnRecovery: { kind: "manual", reason: "Scripted model" },
      resume: fixtureResume(),
      ...(STEERS_AT_STEP.has(harness) && {
        steering: {
          kind: "supported" as const,
          lands: "step" as const,
          via: "Scripted model",
          steer: async (id: string, input: { text: string }) => {
            if (this.options.refuseSteers) return { kind: "not-accepted" as const, reason: "The turn moved on" }
            this.steers.push({ conversation: id, text: input.text, at: Date.now() })
            return { kind: "accepted" as const }
          },
        },
      }),
      provider: harness,
      available: () => true,
      start: async (_cwd, options) => state(options.conversationId, options.resume ? { nativeId: options.resume } : {}),
      prompt: async (id, text, _attachments, _settings, dispatch) => {
        dispatch.report({ kind: "submitted", source: "transport-call" })
        this.prompts.push({ conversation: id, harness, text, at: Date.now() })
        const session = this.live.snapshot(id)?.session ?? state(id)
        this.live.observe({ type: "live-session", session: { ...session, status: "running", nativeRunId: `run-${this.prompts.length}` } })
        const turn = (async () => {
          const reply = await this.options.script({ world: this, conversation: id, harness, text, caller: this.caller(id) })
          this.live.observe({ type: "live-update", id, update: { kind: "text", text: reply } })
          this.live.observe({ type: "live-session", session: { ...(this.live.snapshot(id)?.session ?? session), status: "ready" } })
        })()
        this.running.add(turn)
        void turn.finally(() => this.running.delete(turn))
      },
      permission: async () => {},
      cancel: async (id) => {
        this.holds.get(id)?.()
      },
      close: () => {},
      setMode: async (id) => {
        await this.options.launching?.(id)
      },
    }
  }
}

/** A host with no conversations, for an engine that only follows runs a Thread's shell started: `shown` hears each roster change. */
export function noConversations(shown: (conversation: string) => void): AgentsDeps["live"] {
  const none = () => {
    throw new Error("There's no conversation here")
  }
  return {
    session: () => undefined, held: () => undefined, snapshot: () => null, editQueued: none, transfer: none, submit: none,
    act: async () => none(), cancel: async () => {}, waitingOn: () => undefined, steersAtStep: () => false,
    turnReply: () => undefined, connectedSession: () => null, childrenChanged: shown,
  }
}

/** No Session is followed here: every child is a conversation Mako drives. */
function emptyCatalog(): AgentsDeps["catalog"] {
  return {
    nativePath: () => undefined,
    ref: (): ThreadRef | undefined => undefined,
    page: async (): Promise<ThreadPage | null> => null,
    activity: () => ({}),
    subscribe: () => () => {},
    announce: () => {},
  }
}

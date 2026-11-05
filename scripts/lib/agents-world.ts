import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { EntrySchema, type Entry } from "@mako/sessions/entries"
import type { ThreadPage, ThreadRef } from "@mako/sessions"
import type { SessionModel, SessionSettings } from "@mako/sessions/settings"
import type { HarnessLimit } from "@mako/host/contracts/account-usage"
import type { FinPolicy } from "@mako/host/contracts/fin-tuning"
import type { LiveStartOptions } from "@mako/host/contracts/live-conversations"
import { HostJobs } from "@mako/host/base/host-jobs"
import { ACCESS_TIERS, accessModeId, type AccessTier } from "@mako/host/contracts/access"
import type { AgentCaller, TreeBudget } from "@mako/host/contracts/agents"
import type { ProviderBinding, ResumeVerdict } from "@mako/host/contracts/conversation-control"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { LivePermissionRequest, LivePermissionResponse, LiveSessionMode, LiveSessionState } from "@mako/host/contracts/providers-acp"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { ProcessReads } from "@mako/host/conversations/agent-runs"
import { Agents, type AgentsDeps } from "@mako/host/conversations/agents"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { ProviderLiveDriver, ProviderSteerResult, SteerCapability } from "@mako/host/harnesses/live-driver"
import { handOff } from "@mako/host/harnesses/prompt-dispatch"
import { ThreadStore } from "@mako/host/threads/store"
import { fixtureResume, noCapabilities } from "../fixtures/driver-capabilities.ts"

/** The six harnesses, as an Apex or a child runs on them here: each a scripted driver, two of them steering at the next step as Claude's and OpenCode's do. */
export const HARNESSES = ["claude", "codex", "cursor", "grok", "opencode", "devin"] as const
const STEERS_AT_STEP = new Set<string>(["claude", "opencode"])
/** An approval's answers, as ACP harnesses offer them. */
export const APPROVAL_OPTIONS: LivePermissionRequest["options"] = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
]
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
  /** What the host keeps of conversations in memory (`LiveDependencies.conversationMemory`); the host's own without it. */
  conversationMemory?: ConstructorParameters<typeof LiveConversations>[0]["conversationMemory"]
  /** How long a harness at rest stays connected before it hibernates (`LiveDependencies.providerIdleMs`). */
  providerIdleMs?: number
  /** This Mac's load as a start reads it (`AgentsDeps.capacity`); a start says nothing of it without one. */
  capacity?: AgentsDeps["capacity"]
  /** What this device's capacity hears from the engine's looks (`AgentsDeps.observeCapacity`). */
  observeCapacity?: AgentsDeps["observeCapacity"]
  /** The person's limit of Fins at once (`AgentsDeps.finLimit`); `FIN_LIMIT` without it. */
  finLimit?: () => number
  /** Runs after a Fin's start has written its edge, before the start answers: a launch slow to reply. */
  replying?: (options: LiveStartOptions) => Promise<void> | void
  /** Runs as a harness is asked to cancel a turn, before the turn stops: a harness slow to stop. */
  cancelling?: (conversation: string) => Promise<void> | void
  /** Runs as a Fin's start prepares its worktree and profile, before its edge is written (`mako:live-start`). */
  preparing?: (options: LiveStartOptions) => Promise<void> | void
  /** The person's ceiling across every place (`AgentsDeps.finCeiling`). */
  finCeiling?: () => number
  /** Test override for the wait before Mako continues a turn its exit cut short. */
  autoContinueDelayMs?: number
  /** Each scripted harness keeps its own transcript on disk, a user entry for each prompt it takes, which `history` reads. */
  transcripts?: true
  /** Awaited before a transcript is read, as a slow store makes it wait. */
  reading?: (path: string) => Promise<void> | void
  /** Runs as a launch applies its mode: after its harness started, before its first message is sent. */
  launching?: (conversation: string) => Promise<void> | void
  /** Every steer is refused, as a harness whose turn moved on refuses one. */
  refuseSteers?: true
  /** A harness's own modes, as its real driver declares them, in place of Mako's tier ids. */
  ladders?: Partial<Record<string, readonly LiveSessionMode[]>>
  /** The Sessions the catalog lists, each one a run a shell may have started: none are followed without it. */
  catalog?: AgentsDeps["catalog"]
  /** The processes a new Session's is looked for among. */
  processes?: ProcessReads
  /** Runs as a harness starts, before its driver names the native session it opened (`native-<conversation>`). */
  starting?: (conversation: string, harness: string) => Promise<void> | void
  /** Hears each prompt and steer as its harness takes it, before its turn goes on: what a killed host's harnesses took stays known. */
  heard?: (heard: Heard) => void
  /** What a new conversation of each harness starts on, as its profile says (Mako's pick). */
  defaults?: Partial<Record<string, SessionSettings>>
  /** Each harness's catalog, as its profile lists it; a harness without one has none read. */
  catalogs?: Partial<Record<string, readonly SessionModel[]>>
  /** The person's Settings › Fins and what they last used, by harness. */
  fins?: { chosen?: Partial<Record<string, SessionSettings>>; used?: Partial<Record<string, SessionSettings>> }
  /** Harnesses whose account in use is at its limit, as `HarnessAccounts.limited` reads them. */
  limits?: Partial<Record<string, HarnessLimit>>
  /** The person's harness order. */
  order?: readonly string[]
  /** The person's rules for Fins, as they stand when read. */
  policy?: () => FinPolicy
  /** Whether a conversation asked to move into its worktree and hasn't yet. */
  movePending?: (conversation: string) => boolean
  /**
   * A harness's steering as its real driver declares it, in place of the world's (Claude and OpenCode at the next
   * step, the rest none). `holds`: each steer waits for `answerSteer`, as Cursor holds one while its subagent runs.
   */
  steering?: Partial<Record<string, Pick<Extract<SteerCapability, { kind: "supported" }>, "lands" | "answersOnEnd" | "hears"> & { holds?: true }>>
  /** How long an ask waits on its Apex alone before the person is asked too (`AgentsDeps.apexAnswerMs`). */
  apexAnswerMs?: number
  /** The engine's timers for those waits (`AgentsDeps.later`): a fake clock a test advances itself. */
  later?: AgentsDeps["later"]
  /** The pull requests the host last read for a worktree's branch (`AgentsDeps.heldPulls`). */
  heldPulls?: AgentsDeps["heldPulls"]
  /** The engine's clock (`AgentsDeps.now`), for a case that needs two moments to read the same. */
  now?: () => number
  /** Whether a session may be resumed, as its harness's ownership check says; resumable without it. */
  resumeVerdict?: (binding: ProviderBinding) => Promise<ResumeVerdict>
  /** A harness refusing a prompt before taking it, with its words: nothing was sent. A promise answers late, as a slow refusal does. */
  refusePrompt?: (conversation: string, harness: string) => string | undefined | Promise<string | undefined>
}

/** A message a scripted harness took: a turn's prompt, or a steer into a running one. */
export interface Heard {
  kind: "prompt" | "steer"
  conversation: string
  harness: string
  text: string
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
  /** Conversations whose Threads the person archived (`AgentsDeps.archived`). */
  readonly archived = new Set<string>()
  /** Every answer to an approval a driver was sent: its conversation, its harness's request, and the answer. */
  readonly answers: { conversation: string; request: string; response: LivePermissionResponse; at: number }[] = []
  readonly events: HostEvent[] = []
  /** When each of `events` was emitted, by its place. */
  readonly eventAt: number[] = []
  private asking = new Map<string, { observationId: string; answered: (response: LivePermissionResponse) => void }>()
  store!: ThreadStore
  live!: LiveConversations
  agents!: Agents
  jobs!: HostJobs
  private running = new Set<Promise<unknown>>()
  private holds = new Map<string, () => void>()
  private heldSteers = new Map<string, (answer: ProviderSteerResult) => void>()

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
    const live = new LiveConversations({
      appPath: this.root,
      root: join(this.root, "journals"),
      driver: (provider) => drivers.get(provider),
      history: async (path) => {
        const ref = this.options.catalog?.ref(path)
        if (ref) return this.options.catalog!.page(path)
        if (!this.options.transcripts) return null
        await this.options.reading?.(path)
        if (!existsSync(path)) return null
        const entries = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line): Entry => EntrySchema.parse(JSON.parse(line)))
        return { ref: { harness: "claude", nativeId: path, path }, entries, start: 0, total: entries.length, hasEarlier: false }
      },
      emit: (event) => {
        this.events.push(event)
        this.eventAt.push(Date.now())
      },
      threads: this.store,
      agents: () => this.agents,
      settled: (id) => this.agents?.moved(id),
      autoContinueDelayMs: this.options.autoContinueDelayMs ?? 10,
      ...(this.options.conversationMemory && { conversationMemory: this.options.conversationMemory }),
      ...(this.options.providerIdleMs !== undefined && { providerIdleMs: this.options.providerIdleMs }),
      resumeVerdict: this.options.resumeVerdict ?? (async () => ({ kind: "resumable", record: "same" })),
    })
    this.live = live
    const deps: AgentsDeps = {
      store: () => this.store,
      catalog: this.options.catalog ?? emptyCatalog(),
      jobs: this.jobs,
      live: this.live,
      startLive: async (harness, cwd, options) => {
        // As `mako:live-start` does: a Fin's worktree and profile are prepared, then a stopped one writes no edge. Each
        // host starts on its own conversations: a start the last one left preparing never reaches the next host's.
        await this.options.preparing?.(options)
        if (options.parent && !options.resume && !agents.startWanted(options.parent.op)) throw new Error("Its Apex stopped it before it started.")
        await live.start(harness, cwd, options)
        await this.options.replying?.(options)
      },
      harnesses: () => HARNESSES,
      runs: () => this.options.catalog !== undefined,
      harnessLabel: (harness) => harness[0]!.toUpperCase() + harness.slice(1),
      modes: (harness) => drivers.get(harness)?.modes,
      finChoices: async (harness) => {
        const recommended = this.options.defaults?.[harness]
        const chosen = this.options.fins?.chosen?.[harness]
        const used = this.options.fins?.used?.[harness]
        return { models: this.options.catalogs?.[harness] ?? [], ...(recommended && { recommended }), ...(chosen && { chosen }), ...(used && { used }) }
      },
      catalogOf: (harness) => this.options.catalogs?.[harness],
      ...(this.options.limits && { limited: async (harness: string) => this.options.limits?.[harness] }),
      ...(this.options.order && { harnessOrder: async () => this.options.order! }),
      ...(this.options.policy && { finPolicy: this.options.policy }),
      ...(this.options.movePending && { movePending: this.options.movePending }),
      ...(this.options.budget && { budget: this.options.budget }),
      ...(this.options.capacity && { capacity: this.options.capacity }),
      ...(this.options.observeCapacity && { observeCapacity: this.options.observeCapacity }),
      ...(this.options.finLimit && { finLimit: this.options.finLimit }),
      ...(this.options.finCeiling && { finCeiling: this.options.finCeiling }),
      ...(this.options.processes && { processes: this.options.processes }),
      ...(this.options.apexAnswerMs !== undefined && { apexAnswerMs: this.options.apexAnswerMs }),
      ...(this.options.later && { later: this.options.later }),
      ...(this.options.heldPulls && { heldPulls: this.options.heldPulls }),
      ...(this.options.now && { now: this.options.now }),
      archived: (conversation) => this.archived.has(conversation),
    }
    const agents = new Agents(deps)
    this.agents = agents
    // As the host does (`openConversations`): the turns an exit cut short go on before the engine looks at what waits.
    this.live.continueRestarted()
    this.agents.resume()
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

  /** A top-level conversation on `harness` at `access`, on `tuning`'s model: an Apex once it starts a child. */
  async apex(harness: string, access: AccessTier = "auto", tuning?: SessionSettings): Promise<{ conversation: string; caller: AgentCaller }> {
    const conversation = randomUUID()
    const modeId = this.options.ladders?.[harness]?.find((mode) => mode.access === access)?.id ?? accessModeId(access)
    await this.live.start(harness, this.root, { conversationId: conversation, title: `${harness} apex`, modeId, ...(tuning && { tuning }) })
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

  /**
   * The conversation's harness asks the person, as its running turn would: an
   * approval with `options`, or with `questions` a question asked as one.
   * Resolves with the answer once one reaches the harness, which ends the ask.
   */
  ask(conversation: string, title: string, asked: Pick<LivePermissionRequest, "options" | "questions"> = { options: APPROVAL_OPTIONS }): Promise<LivePermissionResponse> {
    const id = `ask-${randomUUID()}`
    const observationId = randomUUID()
    return new Promise((answered) => {
      this.asking.set(`${conversation}:${id}`, { observationId, answered })
      this.live.observe({ type: "live-permission", request: { id, observationId, sessionId: conversation, title, ...asked } })
    })
  }

  /** Lets a held turn end (`hold`). */
  release(conversation: string): void {
    this.holds.get(conversation)?.()
  }

  /** Answers the steer a holding harness (`steering.holds`) keeps for a conversation; false when it keeps none. */
  answerSteer(conversation: string, answer: ProviderSteerResult): boolean {
    const held = this.heldSteers.get(conversation)
    this.heldSteers.delete(conversation)
    held?.(answer)
    return Boolean(held)
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
      ...((STEERS_AT_STEP.has(harness) || this.options.steering?.[harness]) && {
        steering: {
          kind: "supported" as const,
          lands: "step" as const,
          ...this.options.steering?.[harness],
          via: "Scripted model",
          steer: async (id: string, input: { text: string }): Promise<ProviderSteerResult> => {
            if (this.options.refuseSteers) return { kind: "not-accepted" as const, reason: "The turn moved on" }
            if (this.options.steering?.[harness]?.holds) {
              const answer = await new Promise<ProviderSteerResult>((resolve) => this.heldSteers.set(id, resolve))
              if (answer.kind !== "accepted") return answer
            }
            this.steers.push({ conversation: id, text: input.text, at: Date.now() })
            this.options.heard?.({ kind: "steer", conversation: id, harness, text: input.text })
            return { kind: "accepted" as const }
          },
        },
      }),
      provider: harness,
      available: () => true,
      start: async (_cwd, options) => {
        await this.options.starting?.(options.conversationId, harness)
        return state(options.conversationId, options.resume ? { nativeId: options.resume, ...(options.threadPath && { nativePath: options.threadPath }) } : {})
      },
      prompt: async (id, text, _attachments, _settings, dispatch) => {
        const refused = await this.options.refusePrompt?.(id, harness)
        if (refused) {
          dispatch.report({ kind: "not-accepted", source: "preflight", reason: refused })
          throw new Error(refused)
        }
        handOff(dispatch, { kind: "submitted", source: "transport-call" })
        const path = this.live.snapshot(id)?.session.nativePath ?? state(id).nativePath!
        // A session another program runs (a linked CLI's) keeps its own transcript, which the catalog reads.
        if (this.options.transcripts && path.startsWith(this.root)) {
          mkdirSync(dirname(path), { recursive: true })
          appendFileSync(path, `${JSON.stringify({ type: "user", text, messageId: dispatch.attemptId } satisfies Entry)}\n`)
        }
        this.prompts.push({ conversation: id, harness, text, at: Date.now() })
        this.options.heard?.({ kind: "prompt", conversation: id, harness, text })
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
      permission: async (id, request, response, dispatch) => {
        dispatch.report({ kind: "submitted", source: "callback" })
        this.answers.push({ conversation: id, request, response, at: Date.now() })
        const asked = this.asking.get(`${id}:${request}`)
        if (!asked) return
        this.asking.delete(`${id}:${request}`)
        setTimeout(() => {
          this.live.observe({ type: "live-permission-ended", id, requestId: request, observationId: asked.observationId, source: "native-resolution" })
          asked.answered(response)
        }, 0)
      },
      cancel: async (id) => {
        // A harness slow to stop: its turn goes on until this resolves.
        await this.options.cancelling?.(id)
        this.holds.get(id)?.()
        // A cancelled turn takes its open asks with it, unanswered.
        for (const [key, asked] of this.asking) {
          if (!key.startsWith(`${id}:`)) continue
          this.asking.delete(key)
          this.live.observe({ type: "live-permission-ended", id, requestId: key.slice(id.length + 1), observationId: asked.observationId, source: "request-aborted" })
          asked.answered({ kind: "choice", optionId: null })
        }
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
    session: () => undefined, held: () => undefined, atWork: () => false, resumeHeld: none, stopHolds: () => 0, snapshot: () => null, editQueued: none, transfer: none, submit: none,
    act: async () => none(), cancel: async () => {}, continueTurn: none, leftUnsettled: () => false, waitingOn: () => undefined, pendingAsk: () => undefined, permission: async () => none(), steersAtStep: () => false, steering: () => undefined, interrupt: none,
    turnReply: () => undefined, connectedSession: () => null, childrenChanged: shown, recordDirect: () => false,
    waitsOut: () => false, heldWake: () => undefined, holdWake: () => false,
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

/** A catalog of the Sessions a Thread's shell runs started, written by the test: what `agents_link` and the follower read. */
export function fakeCatalog() {
  const sessions = new Map<string, { ref: ThreadRef; entries: Entry[] }>()
  const subscribers = new Set<(event: HostEvent) => void>()
  const catalog: AgentsDeps["catalog"] = {
    nativePath: (identity) => [...sessions.values()].find((session) => session.ref.harness === identity.harness && session.ref.nativeId === identity.nativeId)?.ref.path,
    ref: (path) => sessions.get(path)?.ref,
    async page(path, before, limit = 50) {
      const session = sessions.get(path)
      if (!session) return null
      const end = before ?? session.entries.length
      const start = Math.max(0, end - limit)
      return { ref: session.ref, entries: session.entries.slice(start, end), start, total: session.entries.length, hasEarlier: start > 0 } satisfies ThreadPage
    },
    activity: () => ({}),
    subscribe(subscriber) {
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    },
    announce: () => {},
  }
  return {
    catalog,
    write(ref: ThreadRef, entries: Entry[]) {
      sessions.set(ref.path, { ref, entries })
      for (const subscriber of subscribers) subscriber({ type: "thread-ref", ref })
    },
  }
}

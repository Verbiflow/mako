import { assertLifecycleAdmission, lifecycleBlocked } from "./application-lifecycle.js"
import type { LifecycleWork } from "./contracts/app-lifecycle.js"
import {
  QueuedPromptEditSchema,
  type QueuedPromptEdit,
} from "./contracts/live-queue.js"
import {
  disconnectNativeAgents,
  observeNativeAgent,
  NativeAgentObservationSchema,
} from "./contracts/native-agents.js"
import type { SessionSettings } from "@mako/sessions/settings"
import { captureNativeHistory } from "./native-history.js"
import { prepareLiveContext, contextPrompt } from "./live-context.js"
import { LiveTransfers } from "./live-transfers.js"
import { LiveCheckpoints } from "./live-checkpoints.js"
import { LiveActions } from "./live-actions.js"
import type { LiveActionInput } from "./contracts/live-actions.js"
import type { RewindInput } from "./contracts/workspace-snapshots.js"
import { LiveChildren } from "./live-children.js"
import { errorMessage } from "./live-runtime.js"
import type {
  LiveAccess,
  Dependencies,
  Resident,
  FailureBoundary,
} from "./live-runtime.js"
import { ForkInputSchema } from "./contracts/conversation-control.js"
import { resolveAnchor } from "./contracts/message-anchor.js"
import type {
  DelegateInput,
  ForkInput,
  TransferInput,
  ConversationControl,
} from "./contracts/conversation-control.js"
import { liveEntries } from "./live-context.js"
import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { join } from "node:path"
import type { SessionFacts } from "./session-memory.js"
import { LiveAssets, promptFingerprint } from "./live-assets.js"
import type { ThreadPage } from "@mako/sessions"
import { z } from "zod"
import type {
  LivePermissionResponse,
  PromptAttachment,
  LiveSessionState,
  LiveDriverEvent,
  LiveRequest,
  LiveSnapshot,
  LiveStartOptions,
  LiveSummary,
} from "./shared.js"
import { reduceLiveUpdates, mergeLiveUpdates } from "./contracts/live-content.js"
import type { InterruptionReason } from "./contracts/live-conversations.js"
import { classifyProviderFailure, classifyStartFailure } from "./contracts/provider-failure.js"
import { CONNECTION_LOST_STOP } from "./contracts/providers-acp.js"
import {
  AUTO_CONTINUE_DELAY_MS,
  autoContinueCandidate,
  continueTurnPrompt,
} from "./contracts/turn-continuation.js"

import { LiveJournal, LiveRequestSchema, journalIds } from "./live-journal.js"
import { hostLog, hostWarn } from "./host-log.js"

/** Owns durable conversation intent and observation. Providers still own execution. */
export class LiveConversations {
  private readonly stops = new Map<string, { requestId: string; result: Promise<boolean> }>()
  private readonly checkpoints: LiveCheckpoints
  private readonly actions: LiveActions
  private readonly transfers: LiveTransfers
  private readonly children: LiveChildren
  private readonly records = new Map<string, Resident>()
  private readonly closedCache = new Map<string, { bytes: number; revision: number }>()
  private readonly bindingOwners = new Map<string, string>()
  private readonly captures = new Map<string, Promise<LiveSnapshot>>()
  private readonly starts = new Map<string, Promise<LiveSessionState>>()
  private readonly recovered = new Map<string, LiveSummary>()
  private readonly assets: LiveAssets
  private readonly dependencies: Dependencies
  /**
   * One generation per host life. Every batch and snapshot carries it so a
   * renderer can tell a revision numbered by this host from one numbered by
   * the host before it, and re-snapshot instead of merging across the seam.
   */
  readonly epoch = randomUUID()
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies
    this.assets = new LiveAssets(join(dependencies.root, "assets"))
    const access: LiveAccess = {
      observe: (event) => this.observe(event),
      retainAttachments: (attachments) => this.assets.retainPrompt(attachments),
      close: (id) => this.close(id),
      pending: (resident) => this.transfers.pending(resident),
      storageFailed: (resident, boundary) =>
        this.storageFailed(resident, boundary),
      dependencies,
      bindingOwners: this.bindingOwners,
      require: (id) => this.require(id),
      load: (id) => this.load(id),
      control: (resident) => this.control(resident),
      flush: (resident) => this.flush(resident),
      drain: (resident) => this.drain(resident),
      open: (provider, cwd, options, ancestry) =>
        this.open(provider, cwd, options, ancestry),
    }
    this.checkpoints = new LiveCheckpoints(access, (id, input) =>
      this.fork(id, input)
    )
    this.actions = new LiveActions(access)
    this.transfers = new LiveTransfers(access)
    this.children = new LiveChildren(access)
    for (const id of journalIds(dependencies.root)) {
      try {
        const journal = new LiveJournal(dependencies.root, id)
        try {
          const summary = journal.summary()
          if (summary) {
            this.backfillMemory(id, summary.session)
            this.recovered.set(id, {
              ...summary,
              session: {
                ...summary.session,
                status:
                  summary.session.status === "closed"
                    ? "closed"
                    : summary.session.status === "ready"
                      ? "ready"
                      : "failed",
                connection: "disconnected",
                error:
                  "The previous provider connection ended. Its saved output is available.",
              },
            })
          }
        } finally {
          journal.close()
        }
      } catch (error) {
        dependencies.emit({
          type: "notice",
          level: "error",
          message: `Saved conversation ${id} could not be opened. Its journal has been preserved for recovery. ${errorMessage({ error })}`,
        })
      }
    }
  }

  /**
   * A journal written before the ledger existed is this host's only record of
   * what its sessions ran under; another host serving the same store had
   * nothing. Each host offers its journals to the ledger once at start,
   * stamped with the journal's write time so a newer observation stays.
   */
  private backfillMemory(id: string, session: LiveSessionState): void {
    const memory = this.dependencies.memory
    if (!memory || !session.nativeId) return
    if (!session.settings && session.currentMode === null) return
    try {
      const facts: SessionFacts = {}
      if (session.settings) facts.settings = session.settings
      if (session.currentMode !== null) facts.modeId = session.currentMode
      // Recent writes sit in the WAL while the main file's mtime stays put.
      const file = join(this.dependencies.root, `${id}.sqlite`)
      const wal = statSync(`${file}-wal`, { throwIfNoEntry: false })
      const at = Math.max(statSync(file).mtimeMs, wal?.mtimeMs ?? 0)
      memory.backfill(session.harness, session.nativeId, facts, at)
    } catch (error) {
      hostWarn("memory", "journal backfill failed", {
        conversation: id,
        harness: session.harness,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  hasActiveWork(): boolean { return this.lifecycleWork().length > 0 }

  lifecycleWork(): LifecycleWork[] {
    const work: LifecycleWork[] = [...this.records.values()].flatMap((resident) => {
      const { snapshot } = resident
      const finishing = resident.transferring || resident.opening || resident.checkpointing || resident.rewinding || resident.closing
      const requests = snapshot.requests.filter((request) => request.status === "dispatching" || request.status === "queued")
      const native = snapshot.nativeAgents?.agents.filter((agent) => agent.state.kind === "working" || agent.state.kind === "waiting") ?? []
      if (!finishing && (!resident.driver || (snapshot.session.status !== "running" && !requests.length && !native.length && !snapshot.permissions.length))) return []
      const status = finishing ? "finishing" : snapshot.permissions.length || native.some((agent) => agent.state.kind === "waiting") ? "waiting" : snapshot.session.status === "running" ? "running" : "queued"
      return [{ id: snapshot.session.id, token: `${resident.generation}:${requests.map((request) => request.id).join(":")}`, title: snapshot.session.title || "Untitled conversation", provider: snapshot.session.harness, cwd: snapshot.session.cwd, status, stoppable: !finishing }]
    })
    for (const id of this.starts.keys()) if (!work.some((item) => item.id === id)) work.push({ id, token: id, title: "Starting an agent", provider: "", cwd: "", status: "finishing", stoppable: false })
    for (const path of this.captures.keys()) work.push({ id: `capture:${path}`, token: path, title: "Saving a conversation", provider: "", cwd: path, status: "finishing", stoppable: false })
    return work
  }

  async closeForExit(ids = [...this.records.keys()]): Promise<void> {
    const results = await Promise.allSettled(ids.map(async (id) => {
      const resident = this.records.get(id)
      if (!resident || resident.snapshot.session.status === "closed") return
      resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map((request) => request.status === "queued" ? { ...request, status: "held" } : request) }
      this.flush(resident)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([this.close(id), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("A provider did not finish closing. Mako stayed open; wait for it to settle before trying again.")), 30_000) })])
      } finally { clearTimeout(timer) }
    }))
    const failure = results.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }

  summaries(): LiveSummary[] {
    return [
      ...[...this.recovered.values()].map((summary) => ({ ...summary, epoch: this.epoch })),
      ...[...this.records.values()].map(({ snapshot }) => ({
        nativePaths: snapshot.control?.bindings.flatMap((binding) =>
          binding.path ? [binding.path] : []
        ),
        session: snapshot.session,
        revision: snapshot.revision,
        epoch: this.epoch,
        threadPath: snapshot.threadPath,
        createdAt: snapshot.createdAt,
      })),
    ]
  }

  snapshot(id: string): LiveSnapshot | null {
    const resident = this.load(id)
    if (!resident) return null
    this.flush(resident)
    return this.stamp(resident.snapshot)
  }

  /** The snapshot as this host numbers it; the renderer merges batches only onto the same epoch. */
  private stamp(snapshot: LiveSnapshot): LiveSnapshot {
    return snapshot.epoch === this.epoch ? snapshot : { ...snapshot, epoch: this.epoch }
  }

  capture(id: string, path: string): Promise<LiveSnapshot> {
    assertLifecycleAdmission()
    z.string().uuid().parse(id)
    const owned = this.summaries().find(
      (summary) =>
        summary.threadPath === path || summary.nativePaths?.includes(path)
    )
    if (owned) return Promise.resolve(this.require(owned.session.id).snapshot)
    const pending = this.captures.get(path)
    if (pending) return pending
    const work = this.captureNative(id, path)
    this.captures.set(path, work)
    void work.finally(() => this.captures.delete(path)).catch(() => {})
    return work
  }

  private async captureNative(id: string, path: string): Promise<LiveSnapshot> {
    const existing = this.load(id)
    if (existing) {
      if (existing.snapshot.base?.ref.path !== path)
        throw new Error("This conversation ID belongs to another source")
      return existing.snapshot
    }
    const before = await this.dependencies.checkpoint?.(path)
    const base = await captureNativeHistory(path, this.dependencies.history)
    if (!base) throw new Error("The source history could not be captured")
    const owned = this.summaries().find((summary) =>
      summary.session.harness === base.ref.harness &&
      summary.session.nativeId === base.ref.nativeId
    )
    if (owned) return this.require(owned.session.id).snapshot
    const after = await this.dependencies.checkpoint?.(path, base.ref.harness)
    const checkpoint = before === after ? after : undefined
    const snapshot: LiveSnapshot = {
      session: {
        id,
        harness: base.ref.harness,
        nativeId: base.ref.nativeId,
        settings: base.ref.settings,
        cwd: base.ref.cwd ?? "",
        title: base.ref.title,
        status: "ready",
        connection: "disconnected",
        modes: [],
        currentMode: null,
        configOptions: [],
      },
      revision: 0,
      createdAt: Date.now(),
      threadPath: path,
      base,
      blocks: [],
      permissions: [],
      requests: [],
      control: {
        children: [],
        merges: [],
        activeBindingId: id,
        bindings: [
          {
            id,
            provider: base.ref.harness,
            nativeId: base.ref.nativeId,
            path,
            checkpoint,
            tuning: base.ref.settings,
            coveredBlocks: 0,
            includesBase: true,
          },
        ],
        transfers: [],
      },
    }
    const journal = new LiveJournal(this.dependencies.root, id)
    try {
      journal.commit(snapshot)
    } catch (error) {
      journal.close()
      throw error
    }
    this.records.set(id, {
      snapshot,
      journalSnapshot: snapshot,
      journal,
      driver: null,
      connections: new Map(),
      transferring: false,
      generation: 0,
      opening: false,
      pendingCharacters: 0,
      updates: [],
      timer: null,
    })
    return snapshot
  }

  start(
    provider: string,
    cwd: string,
    options: LiveStartOptions
  ): Promise<LiveSessionState> {
    assertLifecycleAdmission()
    z.string().uuid().parse(options.conversationId)
    const pending = this.starts.get(options.conversationId)
    if (pending) return pending
    const existing = this.load(options.conversationId)
    if (existing) {
      if (
        existing.snapshot.session.harness !== provider ||
        existing.snapshot.session.cwd !== cwd
      )
        return Promise.reject(
          new Error(
            "This conversation ID already belongs to a different provider or workspace"
          )
        )
      return Promise.resolve(existing.snapshot.session)
    }
    const start = this.open(provider, cwd, options)
    this.starts.set(options.conversationId, start)
    void start
      .finally(() => this.starts.delete(options.conversationId))
      .catch(() => {})
    return start
  }

  private async open(
    provider: string,
    cwd: string,
    options: LiveStartOptions,
    ancestry?: ConversationControl["ancestry"]
  ): Promise<LiveSessionState> {
    const driver = this.dependencies.driver(provider)
    if (!driver?.available(this.dependencies.appPath))
      throw new Error(`${provider} has no available interactive transport`)
    // Reopening a store another Mako host has live would put two agents on
    // one session; the ledger refuses it here, before anything is spawned.
    if (options.resume)
      this.dependencies.memory?.hold(provider, options.resume, options.conversationId)
    // The tier a reopened session last ran under travels into the launch: a
    // launch-enforced tier (OpenCode's Ask, every Grok tier) is read from the
    // process environment and can never be applied to a running session.
    const rememberedMode = options.resume && !options.modeId
      ? this.dependencies.memory?.recall(provider, options.resume)?.modeId
      : undefined
    const modeId = options.modeId ?? rememberedMode
    const base = options.threadPath
      ? await captureNativeHistory(
          options.threadPath,
          this.dependencies.history
        )
      : null
    if (options.threadPath && !base)
      throw new Error(
        "The saved history could not be loaded; the conversation was not started"
      )
    const id = options.conversationId
    const snapshot: LiveSnapshot = {
      control: {
        children: [],
        merges: [],
        ancestry,
        activeBindingId: id,
        bindings: [
          {
            id,
            provider,
            coveredBlocks: 0,
            includesBase: Boolean(options.resume) || !base,
            nativeId: options.resume,
            path: options.threadPath,
            tuning: options.tuning,
          },
        ],
        transfers: [],
      },
      session: {
        id,
        harness: provider,
        cwd,
        title: options.title,
        status: "starting",
        connection: "starting",
        modes: [],
        currentMode: null,
        configOptions: [],
      },
      revision: 0,
      threadPath: options.threadPath,
      createdAt: Date.now(),
      base,
      blocks: [],
      permissions: [],
      requests: options.initialRequest
        ? [
            LiveRequestSchema.parse({
              ...options.initialRequest,
              displayText: options.displayPrompt,
              tuning: options.tuning,
              inputDigest: promptFingerprint(
                options.initialRequest.text,
                options.initialRequest.attachments,
                options.tuning
              ),
              attachments: this.assets.retainPrompt(
                options.initialRequest.attachments
              ),
              status: "queued",
            }),
          ]
        : [],
    }
    const resident: Resident = {
      connections: new Map(),
      transferring: false,
      snapshot,
      journalSnapshot: snapshot,
      driver,
      journal: new LiveJournal(this.dependencies.root, id),
      generation: 0,
      opening: true,
      pendingCharacters: 0,
      updates: [],
      timer: null,
      displayPrompt: options.displayPrompt,
    }
    resident.journal.commit(snapshot)
    this.records.set(id, resident)
    this.bindingOwners.set(id, id)
    const generation = resident.generation
    void driver
      .start(cwd, {
        ...options,
        modeId,
        emit: (event) => this.observe(event),
        mcpSnapshot: this.dependencies.mcpSnapshot
          ? () => this.dependencies.mcpSnapshot!(cwd)
          : undefined,
        conversationTools: this.dependencies.tools?.(id, id),
      })
      .then(async (session) => {
        if (resident.generation !== generation) {
          driver.close(id)
          return
        }
        resident.snapshot = {
          ...resident.snapshot,
          session: {
            ...session,
            title: session.title ?? resident.snapshot.session.title,
          },
        }
        resident.connections.set(id, { driver, session })
        this.updateBinding(resident, session)
        // A host- or launch-enforced tier is already current when the session
        // reports; a provider's own mode (Cursor's plan) is applied here. An
        // explicit choice must apply or fail; the ledger's memory applies only
        // when the session still offers it.
        const offered = session.modes.some((mode) => mode.id === modeId)
        if (modeId && modeId !== session.currentMode && (offered || options.modeId)) {
          if (!offered)
            throw new Error("The saved agent mode is no longer available. Choose a mode before sending.")
          await driver.setMode(id, modeId)
          if (resident.generation !== generation) return
          resident.snapshot = { ...resident.snapshot, session: { ...resident.snapshot.session, currentMode: modeId } }
        }
        resident.opening = false
        this.flush(resident)
        this.drain(resident)
      })
      .catch((error) => {
        if (resident.generation !== generation) return
        resident.opening = false
        resident.driver = null
        resident.connections.clear()
        driver.close(id)
        resident.snapshot = {
          ...resident.snapshot,
          permissions: [],
          session: {
            ...resident.snapshot.session,
            status: "failed",
            connection: "disconnected",
            error: errorMessage({ error }),
          },
          requests: resident.snapshot.requests.map((request) =>
            request.status === "queued"
              ? {
                  ...request,
                  status: "failed",
                  error: errorMessage({ error }),
                  failure: classifyStartFailure(errorMessage({ error }), options.resume !== undefined),
                }
              : request
          ),
        }
        this.flush(resident)
        if (options.resume) this.releaseHold(provider, options.resume, id)
      })
    return snapshot.session
  }

  private releaseHold(provider: string, nativeId: string, conversationId: string): void {
    try {
      this.dependencies.memory?.release(provider, nativeId, conversationId)
    } catch (error) {
      hostWarn("memory", "release failed", { harness: provider, error: error instanceof Error ? error.message : String(error) })
    }
  }

  observe(event: LiveDriverEvent): void {
    try {
      this.accept(event)
    } catch (error) {
      const id =
        event.type === "acp-session"
          ? event.session.id
          : event.type === "acp-permission"
            ? event.request.sessionId
            : event.id
      const resident = this.records.get(this.bindingOwners.get(id) ?? id)
      if (resident) this.storageFailed(resident, { error })
    }
  }

  private accept(raw: LiveDriverEvent): void {
    const bindingId =
      raw.type === "acp-session"
        ? raw.session.id
        : raw.type === "acp-permission"
          ? raw.request.sessionId
          : raw.id
    const owner = this.bindingOwners.get(bindingId) ?? bindingId
    const bound = this.records.get(owner)
    if (!bound) return
    if (this.control(bound).activeBindingId !== bindingId) {
      const connection = bound.connections.get(bindingId)
      if (connection && raw.type === "acp-session") {
        connection.session = raw.session
        if (raw.session.connection === "disconnected")
          bound.connections.delete(bindingId)
      }
      return
    }
    const event: LiveDriverEvent =
      raw.type === "acp-session"
        ? { ...raw, session: { ...raw.session, id: owner } }
        : raw.type === "acp-permission"
          ? { ...raw, request: { ...raw.request, sessionId: owner } }
          : { ...raw, id: owner }
    const id =
      event.type === "acp-session"
        ? event.session.id
        : event.type === "acp-permission"
          ? event.request.sessionId
          : event.id
    const resident = this.records.get(id)
    if (!resident?.driver) return
    if (event.type === "acp-session") {
      const previousStatus = resident.snapshot.session.status
      const finishedRequest = resident.snapshot.requests.find(
        (request) => request.status === "dispatching"
      )
      resident.snapshot = {
        ...resident.snapshot,
        session: {
          ...event.session,
          title: event.session.title ?? resident.snapshot.session.title,
        },
      }
      if (event.session.nativeRunId && event.session.status === "running") {
        const runId = event.session.nativeRunId
        resident.snapshot = {
          ...resident.snapshot,
          requests: resident.snapshot.requests.map((request) =>
            request.status === "dispatching" && !request.nativeRun
              ? { ...request, nativeRun: { bindingId, runId } }
              : request
          ),
        }
      }
      this.updateBinding(resident, event.session)
      const connection = resident.connections.get(bindingId)
      if (connection) connection.session = { ...event.session, id: bindingId }
      if (event.session.connection === "disconnected") {
        resident.snapshot = {
          ...resident.snapshot,
          nativeAgents: disconnectNativeAgents(
            resident.snapshot.nativeAgents,
            bindingId
          ),
        }
        resident.driver = null
        resident.connections.delete(bindingId)
      }
      if (previousStatus === "running" && event.session.status !== "running") {
        this.actions.settle(resident, bindingId)
        resident.snapshot = {
          ...resident.snapshot,
          permissions: [],
          requests: resident.snapshot.requests.map((request) =>
            request.status === "dispatching"
              ? settleRequest(request, event.session)
              : request
          ),
        }
        if (finishedRequest)
          this.checkpoints.settle(resident, finishedRequest.id)
        this.scheduleAutoContinue(resident)
      }
    } else if (event.type === "acp-agent") {
      const agent = NativeAgentObservationSchema.parse(event.agent)
      resident.snapshot = {
        ...resident.snapshot,
        nativeAgents: observeNativeAgent(resident.snapshot.nativeAgents, {
          ...agent,
          bindingId,
          provider: resident.snapshot.session.harness,
          requestId: resident.snapshot.requests.find(
            (request) => request.status === "dispatching"
          )?.id,
          observedAt: Date.now(),
        }),
      }
    } else if (event.type === "acp-permission") {
      resident.snapshot = {
        ...resident.snapshot,
        permissions: [
          ...resident.snapshot.permissions.filter(
            (request) => request.id !== event.request.id
          ),
          event.request,
        ],
      }
    } else if (!(
      resident.opening &&
      (resident.snapshot.base || resident.snapshot.blocks.length)
    )) {
      const updates =
        event.type === "acp-update" ? [event.update] : event.updates
      const dispatching = resident.snapshot.requests.some(
        (request) => request.status === "dispatching"
      )
      const prepared = updates.flatMap((item) => {
        try {
          return this.assets.prepare(item)
        } catch (error) {
          resident.updates.push(item)
          this.storageFailed(resident, { error })
          return []
        }
      })
      for (const update of prepared) {
        if (dispatching && update.kind === "user") continue
        const last = resident.updates.at(-1)
        const merged = mergeLiveUpdates(last, update)
        if (last && merged) {
          const characters = resident.pendingCharacters - JSON.stringify(last).length + JSON.stringify(merged).length
          if (characters <= 256_000) {
            resident.updates[resident.updates.length - 1] = merged
            resident.pendingCharacters = characters
            continue
          }
        }
        const characters = JSON.stringify(update).length
        if (
          resident.updates.length >= 128 ||
          resident.pendingCharacters + characters > 256_000
        )
          this.flush(resident)
        resident.updates.push(update)
        resident.pendingCharacters += characters
      }
    }
    // Control and terminal changes flush ahead of the next turn. Text bursts share one frame.
    if (event.type === "acp-session" || event.type === "acp-permission")
      this.flush(resident)
    else this.schedule(resident)
    if (!resident.opening && resident.snapshot.session.status === "ready")
      this.drain(resident)
  }

  submit(
    id: string,
    requestId: string,
    text: string,
    attachments: PromptAttachment[] = [],
    tuning?: SessionSettings
  ): LiveRequest {
    assertLifecycleAdmission()
    const resident = this.require(id)
    if (resident.rewinding)
      throw new Error("Wait for the workspace rewind to finish before sending")
    if (this.transfers.pending(resident))
      throw new Error(
        "A provider switch is pending. Wait for it to settle before sending another message."
      )
    this.flush(resident)
    const request = LiveRequestSchema.parse({
      id: requestId,
      text,
      attachments,
      tuning,
      status: "queued",
    })
    const inputDigest = promptFingerprint(
      request.text,
      request.attachments,
      request.tuning
    )
    const existing = resident.snapshot.requests.find(
      (candidate) => candidate.id === request.id
    )
    if (existing) {
      if (
        existing.inputDigest
          ? existing.inputDigest !== inputDigest
          : existing.text !== text ||
            JSON.stringify(existing.attachments) !==
              JSON.stringify(attachments) ||
            JSON.stringify(existing.tuning) !== JSON.stringify(tuning)
      )
        throw new Error(
          "This request ID was already accepted with different content"
        )
      if (existing.status === "queued") this.drain(resident)
      return existing
    }
    if (!text.trim() && !attachments.length)
      throw new Error("A prompt cannot be empty")
    // The user's own message supersedes any continuation Mako was about to send.
    this.declineAutoContinue(resident)
    if (!resident.driver) {
      this.transfer(id, {
        id: requestId,
        provider: resident.snapshot.session.harness,
        text,
        attachments,
        tuning,
      })
      return request
    }
    request.inputDigest = inputDigest
    return this.admit(resident, request)
  }

  /** Record a new request in the journal and start it when the session is free. */
  private admit(resident: Resident, request: LiveRequest): LiveRequest {
    request.attachments = this.assets.retainPrompt(request.attachments)
    const previousSnapshot = resident.snapshot
    resident.snapshot = {
      ...resident.snapshot,
      requests: [...resident.snapshot.requests, request],
    }
    // Rejected acceptance must never become a later executable request.
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previousSnapshot
      throw error
    }
    this.drain(resident)
    return request
  }

  /**
   * A turn that just ended on the provider's dropped connection is picked up
   * by Mako after `AUTO_CONTINUE_DELAY_MS`, once per turn. The interrupted
   * request is stamped with the moment so the renderer says "continuing
   * automatically" instead of offering the button; the timer re-checks
   * eligibility when it fires, because the user may have sent something,
   * closed the conversation, or the host may be leaving.
   */
  private scheduleAutoContinue(resident: Resident): void {
    if (resident.autoContinue || !resident.driver || lifecycleBlocked()) return
    const candidate = autoContinueCandidate(resident.snapshot.requests)
    if (!candidate?.interruption) return
    const delay = this.dependencies.autoContinueDelayMs ?? AUTO_CONTINUE_DELAY_MS
    const at = Date.now() + delay
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((request) =>
        request.id === candidate.id && request.interruption
          ? { ...request, interruption: { ...request.interruption, autoContinue: { at } } }
          : request
      ),
    }
    const timer = setTimeout(() => this.fireAutoContinue(resident.snapshot.session.id, candidate.id), delay)
    timer.unref?.()
    resident.autoContinue = { requestId: candidate.id, timer }
  }

  private fireAutoContinue(id: string, requestId: string): void {
    const resident = this.records.get(id)
    if (!resident || resident.autoContinue?.requestId !== requestId) return
    resident.autoContinue = undefined
    const source = autoContinueCandidate(resident.snapshot.requests)
    resident.snapshot = {
      ...resident.snapshot,
      requests: clearAutoContinue(resident.snapshot.requests, requestId),
    }
    if (
      source?.id !== requestId ||
      !source.interruption?.autoContinue ||
      !resident.driver ||
      resident.rewinding ||
      resident.closing ||
      this.transfers.pending(resident) ||
      resident.snapshot.session.status === "running" ||
      resident.snapshot.session.status === "closed" ||
      resident.snapshot.permissions.length > 0
    ) {
      this.flush(resident)
      return
    }
    const reason = source.interruption.reason
    const request = LiveRequestSchema.parse({
      id: randomUUID(),
      text: continueTurnPrompt(reason),
      attachments: [],
      tuning: source.tuning,
      status: "queued",
      continues: { requestId, reason, auto: true },
    })
    request.inputDigest = promptFingerprint(request.text, request.attachments, request.tuning)
    try {
      assertLifecycleAdmission()
      this.admit(resident, request)
      hostLog("live", "continued a dropped turn", {
        conversation: id,
        harness: resident.snapshot.session.harness,
        request: request.id,
        continues: requestId,
      })
    } catch (error) {
      // The manual offer stands; the stamp is already gone from the request.
      hostWarn("live", "auto-continue was not accepted", {
        conversation: id,
        continues: requestId,
        error: error instanceof Error ? error.message : String(error),
      })
      this.flush(resident)
    }
  }

  /** Drop a pending continuation and its stamp; a later prompt, close or host exit made it moot. */
  private declineAutoContinue(resident: Resident): void {
    const pending = resident.autoContinue
    if (!pending) return
    clearTimeout(pending.timer)
    resident.autoContinue = undefined
    resident.snapshot = {
      ...resident.snapshot,
      requests: clearAutoContinue(resident.snapshot.requests, pending.requestId),
    }
  }

  authorizeAgent(
    id: string,
    bindingId: string,
    action: "read" | "delegate" = "read"
  ): void {
    const resident = this.require(id)
    if (
      this.control(resident).activeBindingId !== bindingId ||
      !resident.driver ||
      resident.snapshot.session.status !== "running"
    )
      throw new Error(
        "This provider no longer owns an active turn in this conversation"
      )
    // Provider-specific modes have no cross-provider ordering. Do not silently
    // grant another provider its defaults from a restricted parent mode.
    if (action === "delegate" && resident.snapshot.session.currentMode !== null)
      throw new Error(
        "Delegate from the desk when the parent uses a provider-specific mode"
      )
  }

  childTasks(id: string) {
    return this.control(this.require(id)).children
  }

  availableProviders(): string[] {
    return (this.dependencies.providers?.() ?? []).filter((provider) =>
      this.dependencies.driver(provider)?.available(this.dependencies.appPath)
    )
  }

  delegate(id: string, input: DelegateInput): Promise<LiveSnapshot> {
    assertLifecycleAdmission()
    return this.children.delegate(id, input)
  }
  cancelChild(id: string, childId: string): LiveSnapshot {
    return this.children.cancelChild(id, childId)
  }

  async mergeFork(id: string, mergeId: string): Promise<LiveSnapshot> {
    z.string().uuid().parse(mergeId)
    const source = this.require(id)
    this.flush(source)
    const ancestry = this.control(source).ancestry
    if (ancestry?.kind !== "fork")
      throw new Error("Only a fork can send findings back to its parent")
    const parent = this.require(ancestry.parentId)
    const existing = this.control(parent).merges.find(
      (merge) => merge.id === mergeId
    )
    if (existing) {
      if (existing.sourceId !== id)
        throw new Error("This merge ID belongs to another fork")
      return parent.snapshot
    }
    if (
      source.snapshot.session.status === "running" ||
      source.snapshot.requests.some(
        (request) =>
          request.status === "queued" || request.status === "dispatching"
      )
    )
      throw new Error(
        "Wait for the fork's current turn to finish before transferring findings"
      )
    if (
      !source.snapshot.requests.some(
        (request) => request.status === "completed"
      )
    )
      throw new Error("The fork has no completed findings yet")
    const captured = source.snapshot
    const manifest = await prepareLiveContext({
      snapshot: captured,
      root: join(this.dependencies.root, "context"),
      fromBlock: 0,
      includesBase: false,
    })
    const control = this.control(parent)
    const concurrent = control.merges.find((merge) => merge.id === mergeId)
    if (concurrent) {
      if (concurrent.sourceId !== id)
        throw new Error("This merge ID belongs to another fork")
      return parent.snapshot
    }
    const previous = parent.snapshot
    parent.snapshot = {
      ...previous,
      control: {
        ...control,
        merges: [
          ...control.merges,
          {
            id: mergeId,
            sourceId: id,
            sourceRevision: captured.revision,
            manifest,
            status: "pending",
          },
        ],
      },
    }
    try {
      this.flush(parent)
    } catch (error) {
      parent.snapshot = previous
      throw error
    }
    return parent.snapshot
  }

  fork(id: string, input: ForkInput): LiveSnapshot {
    const command = ForkInputSchema.parse(input)
    const parent = this.require(id)
    this.flush(parent)
    const source = parent.snapshot
    const point = JSON.stringify(command.point)
    const existing = this.load(command.id)
    if (existing) {
      if (
        existing.snapshot.control?.ancestry?.parentId !== id ||
        existing.snapshot.control.ancestry.point !== point ||
        (existing.snapshot.control.ancestry.provider ??
          existing.snapshot.session.harness) !== command.provider
      )
        throw new Error("This fork ID belongs to another source point")
      return existing.snapshot
    }
    let nativeFork: NonNullable<ConversationControl["ancestry"]>["nativeFork"]
    let entries = source.base?.entries ?? []
    if (command.point.kind === "run" || command.point.kind === "before-run") {
      const requestId = command.point.requestId
      const request = source.requests.find(
        (candidate) => candidate.id === requestId
      )
      if (
        !request ||
        (command.point.kind === "run" && request.status !== "completed")
      )
        throw new Error("Fork from a completed answer")
      const binding = source.control?.bindings.find(
        (candidate) => candidate.id === request.nativeRun?.bindingId
      )
      const forkPoint = this.dependencies.driver(command.provider)?.forkPoint
      const nativePoint =
        forkPoint === "checkpoint"
          ? request.nativeRun?.forkId
          : forkPoint === "run"
            ? request.nativeRun?.runId
            : undefined
      if (
        command.point.kind === "run" &&
        binding?.nativeId &&
        request.nativeRun &&
        binding.provider === command.provider &&
        nativePoint
      )
        nativeFork = {
          provider: binding.provider,
          nativeId: binding.nativeId,
          runId: nativePoint,
        }
      const start = source.blocks.findIndex(
        (block) => block.type === "user" && block.requestId === requestId
      )
      if (start < 0)
        throw new Error("The source turn is not present in this capture")
      const next = source.blocks.findIndex(
        (block, index) =>
          index > start && block.type === "user" && !block.steeringFor
      )
      entries = [
        ...entries,
        ...liveEntries(
          source.blocks.slice(
            0,
            command.point.kind === "before-run"
              ? start
              : next < 0
                ? source.blocks.length
                : next
          )
        ),
      ]
    } else {
      const base = source.base
      if (!base)
        throw new Error(
          "The source history changed. Reload it before choosing a fork point."
        )
      let index = command.point.index - base.start
      if (nativeRevision(base) !== command.point.revision) {
        // The store moved since the transcript was read. The answer is still
        // the same message; find it by its own identity rather than refusing.
        const found = command.point.anchor
          ? resolveAnchor(base.entries, base.start, command.point.anchor, "assistant")
          : undefined
        if (found === undefined)
          throw new Error(
            command.point.anchor
              ? "The source history changed and the chosen answer is no longer in it. Reload the thread and choose again."
              : "The source history changed. Reload it before choosing a fork point."
          )
        index = found - base.start
      }
      if (
        index < 0 ||
        index >= base.entries.length ||
        base.entries[index]?.kind !== "assistant"
      )
        throw new Error(
          "Choose an answer present in the captured native history"
        )
      entries = base.entries.slice(0, index + 1)
    }
    const snapshot: LiveSnapshot = {
      session: {
        ...source.session,
        id: command.id,
        harness: command.provider,
        nativeId: undefined,
        nativePath: undefined,
        nativeRunId: undefined,
        nativeForkId: undefined,
        title: source.session.title ? `${source.session.title} — fork` : "Fork",
        status: "ready",
        connection: "disconnected",
        modes: [],
        currentMode: null,
        configOptions: [],
        lastStop: undefined,
        error: undefined,
      },
      revision: 0,
      createdAt: Date.now(),
      blocks: [],
      requests: [],
      permissions: [],
      base: {
        ref: source.base?.ref ?? {
          path: id,
          nativeId: id,
          harness: source.session.harness,
          cwd: source.session.cwd,
        },
        entries,
        start: source.base?.start ?? 0,
        total: entries.length,
        hasEarlier: source.base?.hasEarlier ?? false,
      },
      control: {
        children: [],
        merges: [],
        ancestry: {
          kind: "fork",
          nativeFork,
          provider: command.provider,
          parentId: id,
          sourceRevision: source.revision,
          point,
        },
        activeBindingId: command.id,
        bindings: [],
        transfers: [],
      },
    }
    const journal = new LiveJournal(this.dependencies.root, command.id)
    try {
      journal.commit(snapshot)
    } catch (error) {
      journal.close()
      throw error
    }
    this.records.set(command.id, {
      snapshot,
      journalSnapshot: snapshot,
      journal,
      driver: null,
      connections: new Map(),
      transferring: false,
      generation: 0,
      opening: false,
      pendingCharacters: 0,
      updates: [],
      timer: null,
    })
    return snapshot
  }

  previewRewind(
    id: string,
    requestId: string,
    position: "before" | "after" = "after"
  ) {
    if (this.actions.blocks(this.require(id)))
      throw new Error("Resolve the pending provider action before rewinding")
    return this.checkpoints.preview(id, requestId, position)
  }

  rewind(id: string, input: RewindInput) {
    assertLifecycleAdmission()
    if (this.actions.blocks(this.require(id)))
      throw new Error("Resolve the pending provider action before rewinding")
    return this.checkpoints.rewind(id, input)
  }

  act(id: string, input: LiveActionInput) {
    assertLifecycleAdmission()
    return this.actions.submit(id, input)
  }

  acknowledgeAction(id: string, actionId: string): Promise<void> {
    return this.actions.acknowledge(id, actionId)
  }

  recoverRewinds() {
    return this.checkpoints.recover()
  }

  transfer(id: string, input: TransferInput): LiveSnapshot {
    assertLifecycleAdmission()
    if (this.require(id).rewinding)
      throw new Error(
        "Wait for the workspace rewind to finish before switching providers"
      )
    return this.transfers.accept(id, input)
  }

  private control(resident: Resident): ConversationControl {
    return (
      resident.snapshot.control ?? {
        children: [],
        merges: [],
        activeBindingId: resident.snapshot.session.id,
        bindings: [
          {
            id: resident.snapshot.session.id,
            provider: resident.snapshot.session.harness,
            nativeId: resident.snapshot.session.nativeId,
            path: resident.snapshot.threadPath,
            coveredBlocks: resident.snapshot.blocks.length,
            includesBase: true,
          },
        ],
        transfers: [],
      }
    )
  }

  private updateBinding(resident: Resident, session: LiveSessionState): void {
    const control = this.control(resident)
    const path =
      session.nativePath ??
      resident.snapshot.threadPath ??
      this.dependencies.nativePath?.(session)
    resident.snapshot = {
      ...resident.snapshot,
      threadPath: path,
      control: {
        ...control,
        bindings: control.bindings.map((binding) =>
          binding.id === control.activeBindingId
            ? {
                ...binding,
                nativeId: session.nativeId ?? binding.nativeId,
                path: path ?? binding.path,
              }
            : binding
        ),
      },
    }
  }

  /** Native identity belongs to the host, including sessions never opened in a renderer. */
  discoverNativePaths(): void {
    for (const resident of this.records.values()) {
      if (!resident.driver || resident.snapshot.threadPath) continue
      this.updateBinding(resident, resident.snapshot.session)
      if (!resident.snapshot.threadPath) continue
      this.flush(resident)
      this.checkpointIdle(resident)
    }
  }

  editQueued(id: string, input: QueuedPromptEdit): LiveSnapshot {
    const command = QueuedPromptEditSchema.parse(input)
    const resident = this.require(id)
    const request = resident.snapshot.requests.find(
      (item) => item.id === command.requestId
    )
    if (!request) throw new Error("This queued message is no longer available.")
    if (command.change.kind === "remove" && request.status === "canceled")
      return resident.snapshot
    if (request.status !== "queued" && request.status !== "held")
      throw new Error(
        "This message has already started. Your queued edit was not applied."
      )
    if (request.text !== command.expectedText) {
      if (
        command.change.kind === "edit" &&
        request.text === command.change.text
      )
        return resident.snapshot
      throw new Error(
        "This queued message changed. Review its latest text before editing."
      )
    }
    if (
      command.change.kind === "edit" &&
      !command.change.text.trim() &&
      !request.attachments.length
    )
      throw new Error("A message cannot be empty.")
    let next: LiveRequest
    switch (command.change.kind) {
      case "remove":
        next = { ...request, status: "canceled" }
        break
      case "pause":
        next = { ...request, status: "held" }
        break
      case "resume":
        next = { ...request, status: "queued" }
        break
      case "edit":
        next = {
          ...request,
          status: "queued",
          text: command.change.text,
          displayText: undefined,
        }
        break
    }
    const previous = resident.snapshot
    resident.snapshot = {
      ...previous,
      requests: previous.requests.map((item) =>
        item.id === request.id ? next : item
      ),
    }
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      throw error
    }
    if (command.change.kind !== "pause") this.drain(resident)
    return resident.snapshot
  }

  clearQueue(id: string): LiveSnapshot {
    const resident = this.require(id)
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((request) =>
        request.status === "queued" || request.status === "held"
          ? {
              ...request,
              status: "canceled",
            }
          : request
      ),
    }
    this.flush(resident)
    return resident.snapshot
  }

  async earlier(id: string): Promise<LiveSnapshot> {
    const resident = this.require(id)
    if (this.transfers.pending(resident))
      throw new Error(
        "Wait for the provider switch before loading earlier history"
      )
    const base = resident.snapshot.base
    if (!base?.hasEarlier) return resident.snapshot
    const earlier = await this.dependencies.history(base.ref.path, base.start)
    if (
      earlier &&
      JSON.stringify([
        earlier.checkpoint,
        earlier.ref.revision,
        earlier.ref.bytes,
        earlier.ref.updatedAt,
      ]) !==
        JSON.stringify([
          base.checkpoint,
          base.ref.revision,
          base.ref.bytes,
          base.ref.updatedAt,
        ])
    )
      throw new Error(
        "The native history changed since this capture. Open the current provider history to read earlier turns."
      )
    if (this.transfers.pending(resident))
      throw new Error("History loading was superseded by a provider switch")
    // Another caller may already have prepended this page.
    if (
      earlier &&
      resident.snapshot.base === base &&
      earlier.total >= base.total &&
      earlier.start < base.start
    ) {
      resident.snapshot = {
        ...resident.snapshot,
        control: {
          ...this.control(resident),
          bindings: this.control(resident).bindings.map((binding) => ({
            ...binding,
            includesBase: false,
          })),
        },
        base: {
          ...base,
          entries: [...earlier.entries, ...base.entries],
          start: earlier.start,
          hasEarlier: earlier.hasEarlier,
        },
      }
      this.flush(resident)
    }
    return resident.snapshot
  }

  private checkpointIdle(resident: Resident): void {
    const bindingId = this.control(resident).activeBindingId
    const path = resident.snapshot.threadPath
    const blocks = resident.snapshot.blocks
    if (
      !path ||
      resident.snapshot.session.status !== "ready" ||
      !this.dependencies.checkpoint
    )
      return
    void this.dependencies
      .checkpoint(path, resident.snapshot.session.harness)
      .then((checkpoint) => {
        if (
          !checkpoint ||
          !this.records.has(resident.snapshot.session.id) ||
          this.control(resident).activeBindingId !== bindingId ||
          resident.snapshot.session.status !== "ready" ||
          resident.snapshot.blocks !== blocks ||
          resident.snapshot.threadPath !== path ||
          resident.snapshot.requests.some(
            (request) => request.status === "dispatching"
          )
        )
          return
        const control = this.control(resident)
        resident.snapshot = {
          ...resident.snapshot,
          control: {
            ...control,
            bindings: control.bindings.map((binding) =>
              binding.id === bindingId
                ? { ...binding, checkpoint, coveredBlocks: blocks.length }
                : binding
            ),
          },
        }
        this.flush(resident)
      })
      .catch(() => {})
  }

  async bind(id: string, path: string): Promise<LiveSnapshot> {
    const resident = this.require(id)
    const page = await this.dependencies.history(path)
    if (
      !page ||
      page.ref.nativeId !== resident.snapshot.session.nativeId ||
      page.ref.harness !== resident.snapshot.session.harness
    )
      throw new Error(
        "That native session does not belong to this conversation"
      )
    resident.snapshot = {
      ...resident.snapshot,
      threadPath: path,
      control: {
        ...this.control(resident),
        bindings: this.control(resident).bindings.map((binding) =>
          binding.id === this.control(resident).activeBindingId
            ? { ...binding, path }
            : binding
        ),
      },
    }
    this.flush(resident)
    this.checkpointIdle(resident)
    return resident.snapshot
  }

  async permission(
    id: string,
    requestId: string,
    response: LivePermissionResponse
  ): Promise<void> {
    const resident = this.require(id)
    const request = resident.snapshot.permissions.find(
      (candidate) => candidate.id === requestId
    )
    if (!request || !resident.driver)
      throw new Error("That permission request is no longer pending")
    await resident.driver.permission(
      this.control(resident).activeBindingId,
      requestId,
      response
    )
    resident.snapshot = {
      ...resident.snapshot,
      permissions: resident.snapshot.permissions.filter(
        (candidate) => candidate.id !== requestId
      ),
    }
    this.flush(resident)
  }

  activeRequest(id: string): string | null {
    const resident = this.records.get(id)
    if (!resident?.driver) return null
    return resident.snapshot.requests.find((request) => request.status === "dispatching" || (resident.opening && request.status === "queued"))?.id ?? null
  }

  stopRequest(id: string, requestId: string): Promise<boolean> {
    const previous = this.stops.get(id)
    if (previous?.requestId === requestId) return previous.result
    if (this.activeRequest(id) !== requestId) return Promise.resolve(false)
    const resident = this.require(id)
    const snapshot = resident.snapshot
    resident.snapshot = { ...snapshot, requests: snapshot.requests.map((request) => request.status === "queued" && request.id !== requestId ? { ...request, status: "held" } : request) }
    try { this.flush(resident) } catch (error) { resident.snapshot = snapshot; return Promise.reject(error) }
    for (const child of this.control(resident).children)
      if (child.delivery === "pending" || child.delivery === "queued") this.children.cancelChild(id, child.id)
    const opening = resident.opening
    const result = this.cancelRequest(id, requestId).then(async () => { if (opening) await this.close(id); return true }).catch((error) => { this.stops.delete(id); throw error })
    this.stops.set(id, { requestId, result })
    return result
  }

  async cancelRequest(id: string, requestId: string): Promise<void> {
    const resident = this.require(id)
    if (this.checkpoints.cancelBeforeDispatch(resident, requestId)) return
    const request = resident.snapshot.requests.find(
      (request) => request.id === requestId
    )
    if (request?.status === "dispatching") {
      await resident.driver?.cancel(this.control(resident).activeBindingId)
      return
    }
    const pending = this.transfers.pending(resident)
    if (pending?.input.id === requestId) {
      if (pending.state.kind === "preparing") resident.generation += 1
      this.transfers.save(resident, {
        ...pending,
        state: { kind: "failed", error: "The remote request was canceled" },
      })
    }
    if (request?.status === "queued") {
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((candidate) =>
          candidate.id === requestId
            ? {
                ...candidate,
                status: "interrupted",
                error: "The remote request was canceled",
              }
            : candidate
        ),
      }
      this.flush(resident)
    }
    this.drain(resident)
  }

  async cancel(id: string): Promise<void> {
    const requestId = this.activeRequest(id)
    if (requestId) { await this.stopRequest(id, requestId); return }
    const resident = this.require(id)
    // Stop during the wait before Mako continues a dropped turn is the user's
    // answer: leave the turn where it stopped, and say so.
    if (resident.autoContinue) {
      this.declineAutoContinue(resident)
      this.flush(resident)
      return
    }
    if (this.checkpoints.cancelBeforeDispatch(resident)) return
    for (const child of this.control(resident).children)
      if (child.delivery === "pending" || child.delivery === "queued")
        this.children.cancelChild(id, child.id)
    await resident.driver?.cancel(this.control(resident).activeBindingId)
  }
  async setMode(id: string, modeId: string): Promise<void> {
    const resident = this.require(id)
    if (!resident.driver) throw new Error("The provider is disconnected")
    await resident.driver.setMode(
      this.control(resident).activeBindingId,
      modeId
    )
  }
  async close(id: string): Promise<void> {
    const resident = this.require(id)
    for (const child of this.control(resident).children)
      if (child.delivery === "pending" || child.delivery === "queued")
        this.children.cancelChild(id, child.id)
    resident.generation += 1
    const pending = this.transfers.pending(resident)
    if (pending)
      this.transfers.save(resident, {
        ...pending,
        state: {
          kind: "failed",
          error: "The conversation was closed before the switch completed",
        },
      })
    const idle = resident.snapshot.session.status === "ready"
    const generation = resident.generation
    resident.closing = true
    this.declineAutoContinue(resident)
    const closed = [...resident.connections].map(([bindingId, connection]) =>
      connection.driver.close(bindingId)
    )
    if (resident.opening && resident.driver && !resident.connections.has(this.control(resident).activeBindingId)) closed.push(resident.driver.close(this.control(resident).activeBindingId))
    resident.opening = false
    resident.connections.clear()
    resident.driver = null
    resident.snapshot = {
      ...resident.snapshot,
      session: {
        ...resident.snapshot.session,
        status: "closed",
        connection: "disconnected",
      },
      nativeAgents: disconnectNativeAgents(resident.snapshot.nativeAgents),
      permissions: [],
      requests: resident.snapshot.requests.map((request) =>
        request.status === "queued" || request.status === "dispatching"
          ? {
              ...request,
              status: "uncertain",
              error: "The connection closed before completion",
            }
          : request
      ),
    }
    this.flush(resident)
    // A session closed while still opening never reported its native id, so
    // the hold taken before its start is let go through the binding.
    for (const binding of this.control(resident).bindings)
      if (binding.nativeId) this.releaseHold(binding.provider, binding.nativeId, id)
    try {
      await Promise.all(closed)
      if (
        idle &&
        this.dependencies.checkpoint &&
        resident.generation === generation
      ) {
        const control = this.control(resident)
        const bindings = await Promise.all(
          control.bindings.map(async (binding) => {
            if (!binding.path || binding.id !== control.activeBindingId)
              return binding
            const checkpoint = await this.dependencies.checkpoint?.(
              binding.path, binding.provider
            )
            return {
              ...binding,
              checkpoint,
              coveredBlocks: resident.snapshot.blocks.length,
            }
          })
        )
        if (
          resident.generation === generation &&
          this.records.get(id) === resident
        ) {
          resident.snapshot = {
            ...resident.snapshot,
            control: { ...this.control(resident), bindings },
          }
          this.flush(resident)
        }
      }
    } finally {
      resident.closing = false
      this.drain(resident)
      this.cacheClosed(resident)
    }
  }

  private cacheClosed(resident: Resident): void {
    if (!this.closedLeaf(resident)) return
    const id = resident.snapshot.session.id
    const cached = this.closedCache.get(id)
    const size = cached?.revision === resident.snapshot.revision ? cached.bytes : JSON.stringify(resident.snapshot).length * 2
    this.closedCache.delete(id)
    this.closedCache.set(id, { bytes: size, revision: resident.snapshot.revision })
    let bytes = [...this.closedCache.values()].reduce((total, entry) => total + entry.bytes, 0)
    for (const [key, entry] of this.closedCache) {
      if (key === id || (this.closedCache.size <= 8 && bytes <= 64 * 1024 * 1024)) break
      this.closedCache.delete(key)
      bytes -= entry.bytes
      const held = this.records.get(key)
      if (!held || !this.closedLeaf(held)) continue
      this.flush(held)
      const snapshot = held.snapshot
      this.recovered.set(key, { session: snapshot.session, revision: snapshot.revision, createdAt: snapshot.createdAt, threadPath: snapshot.threadPath, nativePaths: snapshot.control?.bindings.flatMap((binding) => binding.path ? [binding.path] : []) })
      held.journal.close()
      this.records.delete(key)
      for (const binding of snapshot.control?.bindings ?? []) if (this.bindingOwners.get(binding.id) === key) this.bindingOwners.delete(binding.id)
    }
  }

  private closedLeaf(resident: Resident): boolean {
    return resident.snapshot.session.status === "closed" && !resident.driver && !resident.connections.size && !resident.closing && !resident.opening && !resident.transferring && !resident.checkpointing && !resident.rewinding && !resident.snapshot.control?.children.length
  }

  stop(): void {
    for (const resident of this.records.values()) {
      resident.generation += 1
      const driver = resident.driver
      resident.driver = null
      for (const [bindingId, connection] of resident.connections)
        connection.driver.close(bindingId)
      if (resident.opening)
        driver?.close(this.control(resident).activeBindingId)
      // A continuation this host was about to send goes with it; the next
      // host offers the button instead of promising a send it cannot make.
      this.declineAutoContinue(resident)
      // A turn still running now is cut short by this host, on purpose. The
      // journal says so, with the moment, so the next host does not read it
      // as a crash and the transcript can offer to continue the turn. An idle
      // conversation is left as it is, so stopping writes nothing for it.
      if (resident.snapshot.requests.some((request) => request.status === "dispatching"))
        resident.snapshot = {
          ...resident.snapshot,
          requests: interruptRequests(
            resident.snapshot.requests,
            "host-quit",
            "Mako closed while this turn was running"
          ),
        }
      // A child's verdict settles into its parent's journal, so every flush
      // runs before any journal closes.
      this.flush(resident)
    }
    for (const resident of this.records.values()) resident.journal.close()
    this.records.clear()
    this.dependencies.memory?.releaseAll()
  }

  /**
   * Keep the per-user ledger in step with what a connected session reports:
   * its native identity is held while it is connected, and its settings and
   * access mode are recorded whenever they change, so another host — or this
   * one after a restart without its journal — reads the same facts.
   */
  private syncMemory(previous: LiveSessionState, next: LiveSessionState): void {
    const memory = this.dependencies.memory
    if (!memory) return
    try {
      const heldId = previous.connection === "connected" ? previous.nativeId : undefined
      const wasHeld = heldId !== undefined
      if (heldId !== undefined && heldId !== next.nativeId)
        memory.release(previous.harness, heldId, next.id)
      if (!next.nativeId) return
      if (next.connection !== "connected") {
        memory.release(next.harness, next.nativeId, next.id)
        return
      }
      if (!wasHeld || previous.nativeId !== next.nativeId)
        memory.hold(next.harness, next.nativeId, next.id)
      const fresh = !wasHeld || previous.nativeId !== next.nativeId
      const settingsChanged =
        JSON.stringify(previous.settings ?? null) !== JSON.stringify(next.settings ?? null)
      const modeChanged = previous.currentMode !== next.currentMode
      // A session without modes reports null; that is nothing to remember,
      // not a request to forget the tier its last session ran under.
      if (fresh || settingsChanged || modeChanged)
        memory.remember(next.harness, next.nativeId, {
          settings: fresh || settingsChanged ? next.settings : undefined,
          modeId: (fresh || modeChanged) && next.currentMode !== null ? next.currentMode : undefined,
        })
    } catch (error) {
      hostWarn("memory", "ledger update failed", {
        conversation: next.id,
        harness: next.harness,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private drain(resident: Resident): void {
    if (lifecycleBlocked()) return
    if (this.actions.blocks(resident)) return
    if (resident.checkpointing || resident.rewinding || resident.closing) return
    this.children.deliver(resident)
    if (this.transfers.pending(resident)) {
      void this.transfers.perform(resident)
      return
    }
    if (
      resident.opening ||
      !resident.driver ||
      resident.snapshot.session.status === "running" ||
      resident.snapshot.session.status === "closed" ||
      resident.snapshot.requests.some(
        (request) => request.status === "dispatching"
      )
    )
      return
    // Failure does not silently drain old queued work. A new explicit submission can retry.
    const queued = resident.snapshot.requests.filter(
      (request) => request.status === "queued" || request.status === "held"
    )
    const request =
      resident.snapshot.session.status === "failed" ? queued.at(-1) : queued[0]
    if (!request || request.status === "held") return
    const previousSnapshot = resident.snapshot
    const previousUpdates = [...resident.updates]
    const previousCharacters = resident.pendingCharacters
    const previousDisplayPrompt = resident.displayPrompt
    const control = this.control(resident)
    const pendingMerges = control.merges.filter(
      (merge) => merge.status === "pending"
    )
    const current = {
      ...request,
      status: "dispatching" as const,
      context: [
        ...(request.context ?? []),
        ...pendingMerges.map((merge) => merge.manifest),
      ],
    }
    resident.snapshot = {
      ...resident.snapshot,
      control: {
        ...control,
        children: control.children.map((child) =>
          child.deliveryId === request.id && child.delivery === "queued"
            ? { ...child, delivery: "delivered" }
            : child
        ),
        merges: control.merges.map((merge) =>
          merge.status === "pending" ? { ...merge, status: "consumed" } : merge
        ),
      },
      requests: resident.snapshot.requests.map((candidate) =>
        candidate.id === request.id ? current : candidate
      ),
    }
    const text = request.displayText ?? resident.displayPrompt ?? request.text
    resident.displayPrompt = undefined
    if (text || request.attachments.length)
      resident.updates.push({
        kind: "user",
        provider: resident.snapshot.session.harness,
        requestId: request.id,
        contextFiles: current.context.map((manifest) => manifest.file),
        text,
        attachments: request.attachments.map((attachment) => ({
          type: "attachment",
          name: attachment.name,
          mimeType: attachment.mimeType,
          source: attachment.path
            ? { kind: "file", path: attachment.path }
            : attachment.data
              ? { kind: "inline", data: attachment.data }
              : {
                  kind: "unavailable",
                  reason: "Attachment bytes were not retained",
                },
        })),
      })
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previousSnapshot
      resident.updates = previousUpdates
      resident.pendingCharacters = previousCharacters
      resident.displayPrompt = previousDisplayPrompt
      this.storageFailed(resident, { error })
      return
    }
    const generation = resident.generation
    const driver = resident.driver
    void this.checkpoints
      .prompt(resident, current, () =>
        driver.prompt(
          this.control(resident).activeBindingId,
          current.context.reduce(
            (text, manifest) => contextPrompt(manifest, text),
            request.text
          ),
          request.attachments,
          request.tuning
        )
      )
      .catch((error) => {
        if (
          generation !== resident.generation ||
          !resident.snapshot.requests.some(
            (candidate) =>
              candidate.id === request.id && candidate.status === "dispatching"
          )
        )
          return
        resident.snapshot = {
          ...resident.snapshot,
          session: {
            ...resident.snapshot.session,
            status: "failed",
            error: errorMessage({ error }),
          },
          requests: resident.snapshot.requests.map((candidate) =>
            candidate.id === request.id
              ? {
                  ...candidate,
                  status: "failed",
                  error: errorMessage({ error }),
                }
              : candidate
          ),
        }
        this.checkpoints.settle(resident, request.id)
        this.flush(resident)
      })
  }

  private schedule(resident: Resident): void {
    resident.timer ??= setTimeout(() => {
      try {
        this.flush(resident)
      } catch (error) {
        this.storageFailed(resident, { error })
      }
    }, 16)
  }

  private flush(resident: Resident): void {
    if (resident.timer) clearTimeout(resident.timer)
    resident.timer = null
    const previous = resident.journalSnapshot ?? resident.snapshot
    if (
      !resident.updates.length &&
      resident.journalSnapshot === resident.snapshot
    )
      return
    const updates = resident.updates
    const snapshot = {
      ...resident.snapshot,
      blocks: reduceLiveUpdates(resident.snapshot.blocks, updates),
      revision: resident.snapshot.revision + 1,
    }
    resident.journal.commit(snapshot, previous)
    resident.storageFault = false
    resident.updates = []
    resident.pendingCharacters = 0
    resident.snapshot = snapshot
    resident.journalSnapshot = snapshot
    this.syncMemory(previous.session, snapshot.session)
    this.dependencies.emit({
      type: "live-batch",
      batch: {
        id: snapshot.session.id,
        revision: snapshot.revision,
        epoch: this.epoch,
        updates,
        nativeAgents:
          previous.nativeAgents !== snapshot.nativeAgents
            ? snapshot.nativeAgents
            : undefined,
        control:
          previous.control !== snapshot.control ? snapshot.control : undefined,
        base: previous.base !== snapshot.base ? snapshot.base : undefined,
        threadPath:
          previous.threadPath !== snapshot.threadPath
            ? (snapshot.threadPath ?? null)
            : undefined,
        session:
          previous.session !== snapshot.session ? snapshot.session : undefined,
        permissions:
          previous.permissions !== snapshot.permissions
            ? snapshot.permissions
            : undefined,
        requests:
          previous.requests !== snapshot.requests
            ? snapshot.requests
            : undefined,
      },
    })
    if (
      previous.session.status === "running" &&
      snapshot.session.status === "ready"
    )
      this.checkpointIdle(resident)
    if (
      previous.requests !== snapshot.requests ||
      previous.permissions !== snapshot.permissions ||
      previous.session.status !== snapshot.session.status
    )
      this.children.settle(resident)
  }

  private storageFailed(resident: Resident, boundary: FailureBoundary): void {
    if (resident.storageFault) return
    resident.storageFault = true
    this.dependencies.emit({
      type: "notice",
      level: "error",
      message: `The conversation could not be saved. The provider is being stopped; buffered output is retained in memory. ${errorMessage(boundary)}`,
    })
    void resident.driver
      ?.cancel(this.control(resident).activeBindingId)
      .catch(() => {})
  }

  private require(id: string): Resident {
    const resident = this.load(id)
    if (!resident) throw new Error("This conversation is unavailable")
    return resident
  }

  private load(id: string): Resident | undefined {
    const existing = this.records.get(id)
    if (existing) { this.cacheClosed(existing); return existing }
    if (!this.recovered.has(id)) return undefined
    const journal = new LiveJournal(this.dependencies.root, id)
    const previous = journal.read()
    if (!previous) {
      journal.close()
      return undefined
    }
    const snapshot: LiveSnapshot = {
      ...previous,
      nativeAgents: disconnectNativeAgents(previous.nativeAgents),
      control: previous.control
        ? {
            ...previous.control,
            actions: previous.control.actions?.map((action) =>
              action.state.kind === "dispatching" ||
              (action.input.kind === "compact" &&
                action.state.kind === "accepted")
                ? {
                    ...action,
                    state: {
                      kind: "uncertain" as const,
                      reason:
                        "The host restarted before this provider action was confirmed. It will not be retried automatically.",
                    },
                  }
                : action
            ),
            transfers: previous.control.transfers.map((transfer) =>
              transfer.state.kind === "preparing" ||
              transfer.state.kind === "queued"
                ? {
                    ...transfer,
                    state: {
                      kind: "failed" as const,
                      error:
                        "The host restarted before the provider switch was activated. Submit a new switch to retry.",
                    },
                  }
                : transfer
            ),
          }
        : undefined,
      session: {
        ...previous.session,
        status:
          previous.session.status === "closed"
            ? "closed"
            : previous.session.status === "ready"
              ? "ready"
              : "failed",
        connection: "disconnected",
        error:
          previous.session.status === "running"
            ? "The host restarted before completion was confirmed. Saved output is available."
            : undefined,
      },
      permissions: [],
      // A request still dispatching in a journal no host is writing was cut
      // short by a host that never reached `stop()`: it died, or was killed.
      // A continuation that host had scheduled died with it.
      requests: clearAutoContinue(
        interruptRequests(
          previous.requests,
          "host-crashed",
          "Mako closed unexpectedly while this turn was running; whether the provider finished it is unknown"
        )
      ),
    }
    journal.commit(snapshot, previous)
    const resident: Resident = {
      connections: new Map(),
      transferring: false,
      snapshot,
      journal,
      journalSnapshot: snapshot,
      driver: null,
      generation: 0,
      opening: false,
      pendingCharacters: 0,
      updates: [],
      timer: null,
    }
    this.records.set(id, resident)
    this.recovered.delete(id)
    this.children.recover(resident)
    this.cacheClosed(resident)
    return resident
  }
}

function nativeRevision(page: ThreadPage): string {
  return JSON.stringify([page.ref.revision, page.ref.bytes, page.ref.updatedAt])
}

/**
 * The dispatching request's verdict when its session leaves `running`. A
 * Stop is recorded as the user's interruption; a failure carries the kind the
 * provider's text classifies as, so the renderer can say whether sending
 * again is worth anything without reading the text itself.
 */
function settleRequest(request: LiveRequest, session: LiveSessionState): LiveRequest {
  const stopped = /cancel|interrupt/i.test(session.lastStop ?? "")
  const dropped = session.lastStop === CONNECTION_LOST_STOP
  const status = stopped || dropped ? "interrupted" : session.status === "ready" ? "completed" : "failed"
  const settled: LiveRequest = {
    ...request,
    status,
    error: session.error,
    nativeRun:
      request.nativeRun && session.nativeForkId
        ? { ...request.nativeRun, forkId: session.nativeForkId }
        : request.nativeRun,
  }
  if (dropped) {
    // The provider ended the turn on its own dropped connection: the work so
    // far stands, so the request is continuable rather than one to re-send,
    // and the kind is still recorded so the panel can name the connection.
    settled.interruption = { reason: "connection-lost", at: Date.now() }
    settled.failure = "network"
  } else if (status === "interrupted") settled.interruption = { reason: "stopped", at: Date.now() }
  if (status === "failed") settled.failure = classifyProviderFailure(session.error).kind
  return settled
}

/** The requests with the scheduled-continuation stamp removed from `requestId`, or from every request. */
function clearAutoContinue(requests: LiveRequest[], requestId?: string): LiveRequest[] {
  return requests.map((request) => {
    if (!request.interruption?.autoContinue || (requestId !== undefined && request.id !== requestId)) return request
    return { ...request, interruption: { reason: request.interruption.reason, at: request.interruption.at } }
  })
}

/** Mark every in-flight request cut short by the host itself, with the reason and the moment. */
function interruptRequests(
  requests: LiveRequest[],
  reason: Extract<InterruptionReason, "host-quit" | "host-crashed">,
  error: string
): LiveRequest[] {
  const at = Date.now()
  return requests.map((request) =>
    request.status === "dispatching"
      ? {
          ...request,
          status: reason === "host-quit" ? "interrupted" : "uncertain",
          error,
          interruption: { reason, at },
        }
      : request
  )
}

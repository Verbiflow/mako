import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { errorMessage } from "@mako/host/base/error-message"
import { hostLog, hostWarn } from "@mako/host/base/host-log"
import { nativeRecord } from "@mako/host/harnesses"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { capturedThread } from "./live-context.js"
import { LiveJournal } from "./live-journal.js"
import { activeBinding, bindingPath, conversationControl, residentOf, type Dependencies, type LiveAccess, type Resident } from "./live-runtime.js"
import { captureNativeHistory, withSeed } from "./native-history.js"

type SourcesAccess = Pick<LiveAccess,
  "dependencies" | "admission" | "load" | "require" | "resident" | "residents" | "add" | "actor" | "register" |
  "stamp" | "snapshot" | "summaries" | "sameSession" | "flush" | "pending" | "reconcileQuestions" | "scheduleHibernation">

/**
 * Where each conversation's history comes from and where its native session
 * is: captured from a provider's store, read back when the store moves on,
 * paged further back, and found again when the provider names it anew.
 */
export class LiveSources {
  private readonly access: SourcesAccess
  private readonly captures = new Map<string, Promise<LiveSnapshot>>()
  // Refresh reads an already durable conversation; unlike an initial capture,
  // it must not hold shutdown open while waiting on an external native store.
  private readonly refreshes = new Map<string, Promise<LiveSnapshot>>()

  constructor(access: SourcesAccess) {
    this.access = access
  }

  /** The native paths being captured into a journal now. */
  capturing(): IterableIterator<string> {
    return this.captures.keys()
  }

  refreshing(id: string): boolean {
    return this.refreshes.has(id)
  }

  capture(id: string, path: string): Promise<LiveSnapshot> {
    this.access.admission.assert()
    z.string().uuid().parse(id)
    const owned = this.access.summaries().find(
      (summary) =>
        summary.threadPath === path || summary.nativePaths?.includes(path)
    )
    if (owned) return Promise.resolve(this.access.require(owned.session.id).snapshot)
    const pending = this.captures.get(path)
    if (pending) return pending
    const work = this.captureNative(id, path)
    this.captures.set(path, work)
    void work.finally(() => this.captures.delete(path)).catch(() => {})
    return work
  }

  private async captureNative(id: string, path: string): Promise<LiveSnapshot> {
    const { dependencies } = this.access
    const existing = this.access.load(id)
    if (existing) {
      if (existing.snapshot.base?.ref.path !== path)
        throw new Error("This conversation ID belongs to another source")
      return existing.snapshot
    }
    const before = await dependencies.checkpoint?.(path)
    const base = await captureNativeHistory(path, dependencies.history)
    if (!base) throw new Error("The source history could not be captured")
    const owned = this.access.summaries().find((summary) =>
      summary.session.harness === base.ref.harness &&
      summary.session.nativeId === base.ref.nativeId &&
      this.access.sameSession(summary.session.id, { harness: base.ref.harness, nativeId: base.ref.nativeId, identity: base.ref.identity, path })
    )
    if (owned) return this.access.require(owned.session.id).snapshot
    const after = await dependencies.checkpoint?.(path, base.ref.harness)
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
    const journal = new LiveJournal(dependencies.root, id)
    try {
      journal.commit(snapshot)
    } catch (error) {
      journal.close()
      throw error
    }
    this.access.add(residentOf(snapshot, journal))
    this.access.register(snapshot, this.access.actor())
    try { await this.access.reconcileQuestions(this.access.require(id)) } catch (error) {
      hostLog("live", "native question import deferred", { conversation: id, error: errorMessage({ error }) })
    }
    return this.access.require(id).snapshot
  }

  /** Observe native history independently of whether another client owns execution.
   * A single binding records which retained live blocks its native store covers. */
  async refreshedSnapshot(id: string): Promise<LiveSnapshot | null> {
    const resident = this.access.load(id)
    if (!resident) return null
    try {
      const catchup = this.access.reconcileQuestions(resident)
      if (catchup) await catchup
    } catch (error) {
      hostLog("live", "native question refresh deferred", { conversation: id, error: errorMessage({ error }) })
    }
    this.access.flush(resident)
    const base = resident.snapshot.base
    const bindings = resident.snapshot.control?.bindings ?? []
    const binding = bindings.length === 1 ? bindings[0] : undefined
    const path = binding?.path ?? base?.ref.path
    const nativeId = binding?.nativeId ?? base?.ref.nativeId
    const provider = binding?.provider ?? base?.ref.harness
    const covered = binding?.coveredBlocks ?? 0
    if (!path || !nativeId || resident.opening || resident.transferring ||
        resident.snapshot.session.status === "running" ||
        resident.snapshot.requests.some((request) => request.status === "dispatching") ||
        (resident.snapshot.blocks.length > 0 &&
          (!binding?.includesBase || covered !== resident.snapshot.blocks.length)))
      return this.access.snapshot(id)
    const pending = this.refreshes.get(id)
    if (pending) return pending
    const { dependencies } = this.access
    const before = resident.snapshot
    const generation = resident.generation
    const work = (async (): Promise<LiveSnapshot> => {
      try {
        const latest = await dependencies.history(path)
        if (!latest || latest.ref.nativeId !== nativeId || latest.ref.harness !== provider)
          return this.access.stamp(resident.snapshot)
        const sameRevision = base && (resident.snapshot.baseCoveredBlocks ?? 0) === covered && latest.checkpoint !== undefined && latest.checkpoint === base.checkpoint &&
          latest.translator === base.translator &&
          latest.ref.bytes === base.ref.bytes && latest.ref.revision === base.ref.revision &&
          latest.ref.updatedAt === base.ref.updatedAt && latest.total === base.total
        if (sameRevision) return this.access.stamp(resident.snapshot)
        const read = await captureNativeHistory(path, (path, before) =>
          before === undefined ? Promise.resolve(latest) : dependencies.history(path, before))
        const refreshed = read && binding?.seeded
          ? withSeed(read, capturedThread(before, 0, true).entries, binding.seeded) ?? read
          : read
        if (refreshed && this.access.resident(id) === resident &&
            resident.snapshot === before && resident.generation === generation &&
            !resident.opening && !resident.transferring && !this.access.admission.closed &&
            ((before.baseCoveredBlocks ?? 0) !== covered || !isDeepStrictEqual(base, refreshed))) {
          resident.snapshot = { ...before, base: refreshed, baseCoveredBlocks: covered }
          this.access.flush(resident)
        }
      } catch (error) {
        hostLog("live", "native history refresh deferred", { conversation: id, error: errorMessage({ error }) })
      }
      return this.access.stamp(resident.snapshot)
    })()
    this.refreshes.set(id, work)
    void work.finally(() => this.refreshes.delete(id)).catch(() => {})
    return work
  }

  /**
   * The harness dropped its history from native run `run` on, as OpenCode's
   * revert does, whoever asked for it. The live blocks still hold what it
   * dropped; its store holds what remains, so the transcript is read back.
   */
  nativeRewound(resident: Resident, run: string): void {
    const id = resident.snapshot.session.id
    const request = resident.snapshot.requests.find((candidate) => candidate.nativeRun?.runId === run)
    hostLog("live", "native history rewound", { conversation: id, request: request?.id ?? "none" })
    const before = resident.snapshot.base
    void this.refreshedSnapshot(id).then(() => {
      if (this.access.resident(id) !== resident || resident.snapshot.base !== before) return
      const binding = activeBinding(resident)
      hostWarn("live", "a native rewind stays drawn until the store is read again", {
        conversation: id, status: resident.snapshot.session.status,
        covered: binding?.coveredBlocks ?? 0, blocks: resident.snapshot.blocks.length,
      })
    })
  }

  async earlier(id: string): Promise<LiveSnapshot> {
    const resident = this.access.require(id)
    if (this.access.pending(resident))
      throw new Error(
        "Wait for the provider switch before loading earlier history"
      )
    const base = resident.snapshot.base
    if (!base?.hasEarlier) return resident.snapshot
    const earlier = await this.access.dependencies.history(base.ref.path, base.start)
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
    if (this.access.pending(resident))
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
          ...conversationControl(resident),
          bindings: conversationControl(resident).bindings.map((binding) => ({
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
      this.access.flush(resident)
    }
    return resident.snapshot
  }

  async bind(id: string, path: string): Promise<LiveSnapshot> {
    const resident = this.access.require(id)
    const page = await this.access.dependencies.history(path)
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
        ...conversationControl(resident),
        bindings: conversationControl(resident).bindings.map((binding) =>
          binding.id === conversationControl(resident).activeBindingId
            ? { ...binding, path }
            : binding
        ),
      },
    }
    this.access.flush(resident)
    this.checkpointIdle(resident)
    return resident.snapshot
  }

  /** Native identity belongs to the host, including sessions never opened in a renderer. */
  discoverNativePaths(): void {
    for (const resident of this.access.residents()) {
      if (resident.opening || resident.transferring) continue
      this.discoverNativePath(resident)
    }
  }

  discoverNativePath(resident: Resident): void {
    const binding = activeBinding(resident)
    if (!binding?.nativeId || (resident.driver && binding.path)) return
    const session = { ...resident.snapshot.session, harness: binding.provider, nativeId: binding.nativeId, nativePath: binding.path }
    const path = this.access.dependencies.nativePath?.(session)
    if (!path || path === binding.path) return
    updateBinding(this.access.dependencies, resident, { ...session, nativePath: path })
    this.access.flush(resident)
    this.checkpointIdle(resident)
    this.access.scheduleHibernation(resident)
  }

  /** `discoverNativePath`, then the driver's own lookup by native ID when the catalog doesn't list the session. */
  async locateNativePath(resident: Resident): Promise<void> {
    this.discoverNativePath(resident)
    const binding = activeBinding(resident)
    if (!binding?.nativeId || binding.path) return
    const { dependencies } = this.access
    const resume = dependencies.driver(binding.provider)?.resume
    const locate = resume?.kind === "native" ? resume.locate : undefined
    const env = locate ? await (dependencies.accountEnv?.(binding) ?? Promise.resolve(process.env)) : process.env
    const path = await locate?.(binding, resident.snapshot.session.cwd, env).catch((error) => {
      hostWarn("recovery", "native session lookup failed", { harness: binding.provider, binding: binding.id, error: errorMessage({ error }) })
      return undefined
    })
    const current = activeBinding(resident)
    if (!path || current?.id !== binding.id || current.nativeId !== binding.nativeId || current.path) return
    hostLog("recovery", "native session located by its ID", { harness: binding.provider, binding: binding.id })
    updateBinding(dependencies, resident, { ...resident.snapshot.session, harness: binding.provider, nativeId: binding.nativeId, nativePath: path })
    this.access.flush(resident)
  }

  /** Records where the native store stands once an idle conversation's turn is in it, so a later read knows what it covers. */
  checkpointIdle(resident: Resident): void {
    const { dependencies } = this.access
    const bindingId = conversationControl(resident).activeBindingId
    const path = resident.snapshot.threadPath
    const blocks = resident.snapshot.blocks
    if (
      !path ||
      resident.snapshot.session.status !== "ready" ||
      !dependencies.checkpoint
    )
      return
    void dependencies
      .checkpoint(path, resident.snapshot.session.harness)
      .then((checkpoint) => {
        if (
          !checkpoint ||
          this.access.resident(resident.snapshot.session.id) !== resident ||
          conversationControl(resident).activeBindingId !== bindingId ||
          resident.snapshot.session.status !== "ready" ||
          resident.snapshot.blocks !== blocks ||
          resident.snapshot.threadPath !== path ||
          resident.snapshot.requests.some(
            (request) => request.status === "dispatching"
          )
        )
          return
        const control = conversationControl(resident)
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
        this.access.flush(resident)
      })
      .catch(() => {})
  }
}

/** The active binding as the connected `session` reports it: its native ID, record, account and settings. */
export function updateBinding(dependencies: Pick<Dependencies, "driver" | "nativePath">, resident: Resident, session: LiveSessionState): void {
  const control = conversationControl(resident)
  const active = activeBinding(resident)
  const reported = session.nativePath ?? resident.snapshot.threadPath
  // A session that changes native ID (Claude's /clear) can still report the
  // previous session's source; that pairing would reopen the wrong record.
  const renamed = Boolean(active?.nativeId && session.nativeId && session.nativeId !== active.nativeId)
  const driver = resident.driver ?? dependencies.driver(session.harness)
  const before = renamed && active?.path ? nativeRecord(driver, active.path, active.nativeId) : undefined
  const after = renamed && reported ? nativeRecord(driver, reported, session.nativeId) : undefined
  const stale = renamed && Boolean(reported) && (!after || (before?.path === after.path && before.record === after.record))
  const path = bindingPath(dependencies, session, stale ? undefined : reported)
  if (renamed)
    hostLog("live", "a session changed native ID", {
      conversation: resident.snapshot.session.id, harness: session.harness,
      source: path ? (stale ? "found by catalog" : "reported") : "awaiting location",
    })
  const context = session.executionContext && {
    ...session.executionContext,
    store: path ? { kind: "located" as const, path }
      : stale ? { kind: "unavailable" as const, reason: "The session's new native source has not been located yet" }
      : session.executionContext.store,
  }
  resident.snapshot = {
    ...resident.snapshot,
    session: { ...resident.snapshot.session, executionContext: context },
    threadPath: path,
    control: {
      ...control,
      bindings: control.bindings.map((binding) =>
        binding.id === control.activeBindingId
          ? {
              ...binding,
              nativeId: session.nativeId ?? binding.nativeId,
              executionContext: context ?? binding.executionContext,
              path: renamed ? path : path ?? binding.path,
              tuning: session.settings ?? binding.tuning,
              modeId:
                session.currentMode ?? binding.modeId,
            }
          : binding
      ),
    },
  }
}

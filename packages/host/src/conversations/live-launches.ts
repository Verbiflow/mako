import { z } from "zod"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { AdmittedLiveDriver } from "../harnesses/index.js"
import { retriesBegun } from "../contracts/delivery-retry.js"
import type { LiveSnapshot, LiveStartOptions } from "../contracts/live-conversations.js"
import type { LiveSessionState } from "../contracts/providers-acp.js"
import type { Actor } from "../contracts/thread-identity.js"
import type { StartPurpose } from "../contracts/thread-purposes.js"
import type { SessionSettings } from "@mako/sessions/settings"
import { promptFingerprint } from "./live-assets.js"
import { LiveJournal, LiveRequestSchema } from "./live-journal.js"
import { releaseHold } from "./live-ledger.js"
import { snapshotFacts } from "./live-moves.js"
import { activeBinding, launchAccount, launchCalls, launched, launchRouting, residentOf, revokeTools, type LiveAccess, type Resident } from "./live-runtime.js"
import { updateBinding } from "./live-sources.js"
import { captureNativeHistory } from "./native-history.js"

type LaunchAccess = Pick<LiveAccess,
  "dependencies" | "admission" | "load" | "add" | "bindingOwners" | "startingSession" | "register" | "markPurpose" | "markParent" |
  "actor" | "retainAttachments" | "moves" | "flush" | "noteWork" | "drain" | "scheduleHibernation" | "failedStart" | "driverEvents">

/** New conversations, from their journal's first write to their provider's first native session. */
export class LiveLaunches {
  private readonly access: LaunchAccess
  private readonly starts = new Map<string, Promise<LiveSessionState>>()

  constructor(access: LaunchAccess) {
    this.access = access
  }

  /** Conversations whose journal is still being prepared. */
  startingIds(): IterableIterator<string> {
    return this.starts.keys()
  }

  starting(id: string): boolean {
    return this.starts.has(id)
  }

  start(
    provider: string,
    cwd: string,
    options: LiveStartOptions,
    actor?: Actor,
    purpose?: StartPurpose
  ): Promise<LiveSessionState> {
    this.access.admission.assert()
    z.string().uuid().parse(options.conversationId)
    const pending = this.starts.get(options.conversationId)
    if (pending) return pending
    const existing = this.access.load(options.conversationId)
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
    const start = this.open(provider, cwd, options, actor, purpose)
    this.starts.set(options.conversationId, start)
    void start
      .finally(() => this.starts.delete(options.conversationId))
      .catch(() => {})
    return start
  }

  /**
   * Where a start runs. A new tab of a Thread, or a closed conversation
   * reopened under its native session, whose worktree was removed goes on in
   * the project folder the worktree was made from; a resume does only when
   * its harness resumes a session in another folder.
   */
  folder(provider: string, cwd: string, options: Pick<LiveStartOptions, "conversationId" | "resume" | "session">): string {
    const { dependencies } = this.access
    const driver = dependencies.driver(provider)
    const moves = options.resume ? driver?.resume.kind === "native" && Boolean(driver.resume.elsewhere) : options.session !== undefined
    const home = moves ? dependencies.projectFolderOfRemoved?.(cwd) : undefined
    if (!home) return cwd
    hostLog("residency", "a session starts in the project folder of its removed worktree", { conversation: options.conversationId, from: cwd, to: home })
    return home
  }

  private async open(
    provider: string,
    asked: string,
    options: LiveStartOptions,
    actor?: Actor,
    purpose?: StartPurpose
  ): Promise<LiveSessionState> {
    const { dependencies } = this.access
    const driver = dependencies.driver(provider)
    if (!driver?.available(dependencies.appPath))
      throw new Error(`${provider} has no available interactive transport`)
    const cwd = this.folder(provider, asked, options)
    // The tier a reopened session last ran under travels into the launch: a
    // launch-enforced tier (OpenCode's Ask, every Grok tier) is read from the
    // process environment and can never be applied to a running session.
    const remembered = options.resume
      ? dependencies.memory?.recall(provider, options.resume)
      : undefined
    const rememberedMode =
      !options.modeId ? remembered?.modeId : undefined
    const modeId = options.modeId ?? rememberedMode
    const tuning = options.tuning ?? remembered?.settings
    const base = options.threadPath
      ? await captureNativeHistory(
          options.threadPath,
          dependencies.history
        )
      : null
    if (options.threadPath && !base)
      throw new Error(
        "The saved history could not be loaded; the conversation was not started"
      )
    const id = options.conversationId
    const session = options.session === undefined ? undefined : this.access.startingSession(options.session)
    const snapshot: LiveSnapshot = {
      control: {
        merges: [],
        session,
        activeBindingId: id,
        bindings: [
          {
            id,
            provider,
            coveredBlocks: 0,
            includesBase: Boolean(options.resume) || !base,
            nativeId: options.resume,
            ...options.resume !== undefined && { resumed: true as const },
            path: options.threadPath,
            tuning,
            modeId,
            ...options.account !== undefined && { account: options.account },
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
        settings: tuning,
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
              createdAt: Date.now(),
              ...options.initialRequest,
              actor: this.access.actor(actor),
              targetBindingId: options.resume ? id : undefined,
              displayText: options.displayPrompt,
              tuning,
              inputDigest: promptFingerprint(
                options.initialRequest.text,
                options.initialRequest.attachments,
                tuning
              ),
              attachments: this.access.retainAttachments(
                options.initialRequest.attachments
              ),
              status: "queued",
            }),
          ]
        : [],
    }
    // Checked with no wait before the journal exists, so a move released
    // during the history read above is seen here.
    this.access.moves.assertOpens(snapshotFacts(snapshot))
    const resident = residentOf(snapshot, new LiveJournal(dependencies.root, id), {
      driver,
      opening: true,
      displayPrompt: options.displayPrompt,
    })
    let held = false
    try {
      // The ledger hold is taken after every fallible history read but before
      // anything can spawn. A failed journal commit releases it immediately.
      if (options.resume) {
        dependencies.memory?.hold(
          provider,
          options.resume,
          options.conversationId
        )
        held = true
      }
      resident.journal.commit(snapshot)
    } catch (error) {
      resident.journal.close()
      if (held && options.resume)
        releaseHold(dependencies.memory, provider, options.resume, options.conversationId)
      throw error
    }
    this.access.add(resident)
    this.access.bindingOwners.set(id, id)
    this.access.register(snapshot, this.access.actor(actor))
    if (options.parent && !options.resume) this.access.markParent(id, options.parent)
    if (purpose) this.access.markPurpose(id, purpose, options)
    dependencies.opened?.(id)
    this.launch(resident, driver, provider, cwd, options, modeId, tuning)
    return snapshot.session
  }

  /**
   * Starts again a conversation whose first launch failed before any native session existed, as it was asked to
   * start, for the messages that waited for it (`LiveRequest.retry`): nothing to resume, so a launch, not a wake.
   * False when there's nothing to start: its harness isn't here, or it has a session or a start already.
   */
  relaunch(resident: Resident): boolean {
    const { dependencies } = this.access
    const binding = activeBinding(resident)
    const { session } = resident.snapshot
    const driver = dependencies.driver(session.harness)
    if (!binding || launched(binding) || resident.driver || resident.opening || resident.closing || !driver?.available(dependencies.appPath)) return false
    resident.driver = driver
    resident.opening = true
    resident.snapshot = { ...resident.snapshot, session: { ...session, status: "starting", connection: "starting", error: undefined } }
    hostLog("residency", "a conversation whose first start failed for now starts again", { conversation: session.id, harness: session.harness, binding: binding.id })
    // Under its active binding's ID, which every message is sent to: a binding a move made isn't the conversation's own,
    // and one started under the conversation's ID took no message (2026-11-11: "The agent execution owner is unavailable").
    this.launch(resident, driver, session.harness, session.cwd, {
      conversationId: binding.id,
      ...session.title !== undefined && { title: session.title },
      ...binding.modeId !== undefined && { modeId: binding.modeId },
    }, binding.modeId, binding.tuning ?? session.settings)
    return true
  }

  /**
   * Start the conversation's first native session, or its active binding's when it never ran (`relaunch`); its outcome
   * lands on the resident. `options.conversationId` names the binding the driver runs it under; what the conversation
   * is handed (its tools, routing and calls) stays the conversation's.
   */
  launch(
    resident: Resident,
    driver: AdmittedLiveDriver,
    provider: string,
    cwd: string,
    options: LiveStartOptions,
    modeId: string | undefined,
    tuning: SessionSettings | undefined
  ): void {
    const { dependencies } = this.access
    const id = options.conversationId
    const conversation = resident.snapshot.session.id
    const generation = resident.generation
    // A start is what a person waits on: the host's routine work waits for it (`base/foreground.ts`).
    const releaseForeground = dependencies.foreground?.hold(`start ${provider} ${id.slice(0, 8)}`)
    const openingOperation = Promise.resolve()
      .then(async () => {
        const conversationTools = await dependencies.tools?.(id, conversation)
        const threadEnvironment = await dependencies.threadEnvironment?.(conversation, options.title, cwd)
        // Preparation may finish after Close or an execution-ownership move.
        // Check and start without yielding so a stale owner never spawns.
        if (resident.generation !== generation || resident.closing || !this.access.moves.executes(resident))
          throw new Error("Execution ownership changed while preparing the native session.")
        return nativeStart(resident, driver, id, () => driver.start(cwd, {
          ...options,
          modeId,
          tuning,
          emit: this.access.driverEvents(resident, id),
          mcpSnapshot: dependencies.mcpSnapshot
            ? () => dependencies.mcpSnapshot!(cwd)
            : undefined,
          conversationTools,
          threadEnvironment,
          nativeRouting: launchRouting(dependencies, conversation, conversationTools),
          nativeCalls: launchCalls(dependencies, conversation, cwd, conversationTools, threadEnvironment),
          pinnedAccount: launchAccount(resident, provider),
          unattended: dependencies.unattended,
        }))
      })
      .then(async (session) => {
        if (resident.generation !== generation) {
          try {
            await driver.close(id)
            await revokeTools(dependencies, id, conversation)
            resident.opening = false
            resident.driver = null
            this.access.noteWork(resident)
          } catch (error) {
            resident.driver = driver
            resident.connections.set(id, { driver, session })
            throw error
          }
          return
        }
        // The driver reports its session under the binding it runs (a relaunched one isn't the conversation's own);
        // the conversation keeps its ID, as a wake's and a transfer's do.
        const connected = {
          ...session,
          id: conversation,
          title: session.title ?? resident.snapshot.session.title,
        }
        resident.snapshot = { ...resident.snapshot, session: connected }
        resident.connections.set(id, { driver, session: { ...connected, id } })
        updateBinding(dependencies, resident, connected)
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
        this.access.flush(resident)
        this.access.drain(resident)
        this.access.scheduleHibernation(resident)
      })
      .catch(async (error) => {
        if (resident.generation !== generation) return
        const closed = await Promise.resolve(driver.close(id)).then(
          () => true,
          () => false
        )
        await revokeTools(dependencies, id, conversation)
        resident.opening = !closed
        resident.driver = closed ? null : driver
        if (closed) resident.connections.clear()
        const requests = this.access.failedStart(resident, { error }, options.resume !== undefined)
        // A message that goes again by itself leaves the session to reopen then, not failed.
        const waits = retriesBegun(resident.snapshot.requests, requests)
        resident.snapshot = {
          ...resident.snapshot,
          permissions: [],
          session: {
            ...resident.snapshot.session,
            status: waits ? "ready" : "failed",
            connection: closed ? "disconnected" : "connected",
            error: waits ? undefined : errorMessage({ error }),
          },
          requests,
        }
        this.access.flush(resident)
        if (closed && options.resume)
          releaseHold(dependencies.memory, provider, options.resume, conversation)
      })
    resident.openingOperation = openingOperation
    void openingOperation.finally(() => {
      releaseForeground?.()
      dependencies.foreground?.started()
      if (resident.openingOperation === openingOperation)
        resident.openingOperation = undefined
    })
  }
}

/** Every native start, so Close can cancel its setup and a reconnect never races the exited process's cleanup. */
export async function nativeStart(
  resident: Resident,
  driver: AdmittedLiveDriver,
  bindingId: string,
  start: () => Promise<LiveSessionState>
): Promise<LiveSessionState> {
  await resident.exited?.get(bindingId)
  const entry = { driver, bindingId }
  resident.starting = entry
  try {
    return await start()
  } finally {
    if (resident.starting === entry) resident.starting = undefined
  }
}

/** A process that exited by itself still owns its binding and account until its driver closes it. */
export function releaseExited(resident: Resident, driver: AdmittedLiveDriver, conversation: string, bindingId: string): void {
  const cleanup = Promise.resolve()
    .then(() => driver.close(bindingId))
    .catch((error) => hostWarn("live", "an exited session's cleanup failed", { conversation, harness: driver.provider, error: errorMessage({ error }) }))
  const exited = (resident.exited ??= new Map())
  exited.set(bindingId, cleanup)
  void cleanup.finally(() => { if (exited.get(bindingId) === cleanup) exited.delete(bindingId) })
}

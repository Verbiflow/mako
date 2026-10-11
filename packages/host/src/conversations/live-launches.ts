import { z } from "zod"
import { errorMessage } from "../base/error-message.js"
import { hostWarn } from "../base/host-log.js"
import type { AdmittedLiveDriver } from "../harnesses/index.js"
import type { LiveSnapshot, LiveStartOptions } from "../contracts/live-conversations.js"
import type { LiveSessionState } from "../contracts/providers-acp.js"
import type { Actor } from "../contracts/thread-identity.js"
import type { StartPurpose } from "../contracts/thread-purposes.js"
import type { SessionSettings } from "@mako/sessions/settings"
import { promptFingerprint } from "./live-assets.js"
import { LiveJournal, LiveRequestSchema } from "./live-journal.js"
import { releaseHold } from "./live-ledger.js"
import { snapshotFacts } from "./live-moves.js"
import { residentOf, revokeTools, type LiveAccess, type Resident } from "./live-runtime.js"
import { updateBinding } from "./live-sources.js"
import { captureNativeHistory } from "./native-history.js"

type LaunchAccess = Pick<LiveAccess,
  "dependencies" | "admission" | "load" | "add" | "bindingOwners" | "startingSession" | "register" | "markPurpose" |
  "actor" | "retainAttachments" | "moves" | "flush" | "drain" | "scheduleHibernation" | "failedStart" | "driverEvents">

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

  private async open(
    provider: string,
    cwd: string,
    options: LiveStartOptions,
    actor?: Actor,
    purpose?: StartPurpose
  ): Promise<LiveSessionState> {
    const { dependencies } = this.access
    const driver = dependencies.driver(provider)
    if (!driver?.available(dependencies.appPath))
      throw new Error(`${provider} has no available interactive transport`)
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
            path: options.threadPath,
            tuning,
            modeId,
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
    if (purpose) this.access.markPurpose(id, purpose, options)
    this.launch(resident, driver, provider, cwd, options, modeId, tuning)
    return snapshot.session
  }

  /** Start the conversation's first native session; its outcome lands on the resident. */
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
    const generation = resident.generation
    const openingOperation = Promise.resolve()
      .then(async () => {
        const conversationTools = await dependencies.tools?.(id, id)
        const threadEnvironment = await dependencies.threadEnvironment?.(id, options.title, cwd)
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
        }))
      })
      .then(async (session) => {
        if (resident.generation !== generation) {
          try {
            await driver.close(id)
            await revokeTools(dependencies, id, id)
            resident.opening = false
            resident.driver = null
          } catch (error) {
            resident.driver = driver
            resident.connections.set(id, { driver, session })
            throw error
          }
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
        updateBinding(dependencies, resident, session)
        // A host- or launch-enforced tier is already current when the session
        // reports; a provider's own mode (Cursor's plan) is applied here. A
        // process launched at another tier than the one asked for runs as the
        // harness's own settings say, which the launch told the transcript;
        // selecting the asked tier now could only fail. An explicit choice
        // must apply or fail; the ledger's memory applies only when the
        // session still offers it.
        const requested = session.modes.find((mode) => mode.id === modeId)
        const offered = requested !== undefined
        const overridden = requested?.enforcement === "launch" && session.launchMode !== undefined && session.launchMode !== modeId
        if (modeId && modeId !== session.currentMode && !overridden && (offered || options.modeId)) {
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
        await revokeTools(dependencies, id, id)
        resident.opening = !closed
        resident.driver = closed ? null : driver
        if (closed) resident.connections.clear()
        resident.snapshot = {
          ...resident.snapshot,
          permissions: [],
          session: {
            ...resident.snapshot.session,
            status: "failed",
            connection: closed ? "disconnected" : "connected",
            error: errorMessage({ error }),
          },
          requests: this.access.failedStart(resident, { error }, options.resume !== undefined),
        }
        this.access.flush(resident)
        if (closed && options.resume)
          releaseHold(dependencies.memory, provider, options.resume, id)
      })
    resident.openingOperation = openingOperation
    void openingOperation.finally(() => {
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

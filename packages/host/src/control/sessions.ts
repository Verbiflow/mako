import { ControlFault } from "@mako/control/control"
import type { ControlAgentOperation } from "@mako/control-runtime/mcp"
import { hostWarn } from "../base/host-log.js"
import {
  ControlWorkers,
  startDesktopControlSession,
  type ControlLaunch,
} from "@mako/control-runtime/session"
import { trackProviderChild } from "../base/provider-children.js"
import type { ControlCredentials } from "./service.js"

type Session = Awaited<ReturnType<typeof startDesktopControlSession>>
/** A binding's grant on the host's driver broker (`DriverBroker.grant`). */
type NativeDriver = { broker: string; token: string }
const STALE = "Local Control is off for new agent sessions: this Mako host is older than the Local Control code on disk. Restart Mako to load it."

/**
 * The live conversation owner starts and revokes each exact binding. A
 * binding's session listens from its launch; its worker starts at the first
 * computer or browser call, from one shared pool.
 */
export class ControlSessions {
  private readonly sessions = new Map<string, Promise<Session>>()
  private readonly finishing = new Map<string, Promise<void>>()
  private closing: Promise<void> | undefined
  private readonly launches = new Map<string, ControlLaunch>()
  private readonly native: (bindingId: string) => Promise<NativeDriver | undefined>
  private readonly release: (bindingId: string) => void
  private readonly launchSession: typeof startDesktopControlSession
  private readonly workers: ControlWorkers
  constructor(
    /** The binding's grant on the driver broker, asked for when its worker starts; undefined without a driver. */
    native: (bindingId: string) => Promise<NativeDriver | undefined>,
    launchSession = startDesktopControlSession,
    workers = new ControlWorkers({
      onSpawn: (child) => trackProviderChild(child, { kind: "local-control", owner: "worker" }),
    }),
    /** The binding ended: its grant is withdrawn. */
    release: (bindingId: string) => void = () => {}
  ) {
    this.native = native
    this.release = release
    this.launchSession = launchSession
    this.workers = workers
  }

  async start(
    bindingId: string,
    browser?: ControlCredentials,
    onEnded: (reason: "stopped" | "failed") => Promise<void> = async () => {},
    /** The JSONL file that gets a line for each of the session's requests. */
    journal?: string
  ): Promise<ControlLaunch> {
    if (this.closing) throw new Error("Local Control supervisor is closing")
    if (this.workers.stale) throw new ControlFault("incompatible-session", STALE, "not-dispatched")
    if (this.sessions.has(bindingId) || this.finishing.has(bindingId))
      throw new Error("Local Control binding is already running")
    const pending = this.launchSession(
      { taskId: bindingId, browser, journal },
      { workers: this.workers, native: () => this.native(bindingId) }
    )
    this.sessions.set(bindingId, pending)
    try {
      const session = await pending
      if (this.sessions.get(bindingId) !== pending) {
        await session.close()
        throw new Error("Local Control binding ended during startup")
      }
      this.launches.set(bindingId, session.launch)
      void session.exited.then((reason) => {
        if (this.sessions.get(bindingId) !== pending) return
        this.sessions.delete(bindingId)
        this.launches.delete(bindingId)
        this.release(bindingId)
        const finishing = Promise.resolve()
          .then(() => onEnded(reason))
          .catch(() => {
            hostWarn("local-control", "Worker cleanup failed", { bindingId })
          })
          .finally(() => this.finishing.delete(bindingId))
        this.finishing.set(bindingId, finishing)
      })
      return session.launch
    } catch (error) {
      if (this.sessions.get(bindingId) === pending)
        this.sessions.delete(bindingId)
      this.release(bindingId)
      throw error
    }
  }
  /**
   * Local Control is a capability of a conversation, not a condition for it:
   * when the session cannot start, the provider starts without it and the
   * reason is returned for the user.
   */
  async startOptional(
    ...args: Parameters<ControlSessions["start"]>
  ): Promise<{ launch: ControlLaunch } | { unavailable: string }> {
    try {
      return { launch: await this.start(...args) }
    } catch (error) {
      const stale = error instanceof ControlFault && error.code === "incompatible-session"
      hostWarn("local-control", "Session did not start; the conversation continues without it", {
        bindingId: args[0], reason: stale ? "host-older-than-disk" : error instanceof Error ? error.message : String(error),
      })
      return {
        unavailable: stale
          ? STALE
          : "Local Control could not start, so this agent session continues without computer and browser control.",
      }
    }
  }
  get(bindingId: string): ControlLaunch | undefined {
    return this.launches.get(bindingId)
  }
  /** Each binding's worker, once its first call started one, and the spare. */
  async processes(): Promise<{ bindings: Record<string, number | undefined>; spare: number | undefined }> {
    const bindings: Record<string, number | undefined> = {}
    for (const [id, pending] of this.sessions) bindings[id] = (await pending.catch(() => undefined))?.pid
    return { bindings, spare: this.workers.sparePid }
  }
  async request(bindingId: string, operation: ControlAgentOperation, signal: AbortSignal) {
    const pending = this.sessions.get(bindingId)
    const session = await pending
    if (!session || this.sessions.get(bindingId) !== pending)
      throw new ControlFault("session-closed", "This task’s Local Control session is no longer active.", "not-dispatched")
    return session.request(operation, signal)
  }
  async stop(bindingId: string): Promise<void> {
    const pending = this.sessions.get(bindingId)
    this.sessions.delete(bindingId)
    this.launches.delete(bindingId)
    this.release(bindingId)
    await (await pending?.catch(() => undefined))?.close()
    await this.finishing.get(bindingId)
  }
  close(): Promise<void> {
    return (this.closing ??= Promise.all(
      [...this.sessions.keys()]
        .map((id) => this.stop(id))
        .concat([...this.finishing.values()])
    ).then(() => this.workers.close()))
  }
}

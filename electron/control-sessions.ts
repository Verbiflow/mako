import { ControlFault } from "@mako/control/control"
import type { ControlAgentOperation } from "@mako/control-runtime/mcp"
import { hostWarn } from "./host-log.js"
import {
  startDesktopControlSession,
  type ControlLaunch,
} from "@mako/control-runtime/session"
import { trackProviderChild } from "./provider-children.js"
import type { ControlCredentials } from "./control-service.js"

type Session = Awaited<ReturnType<typeof startDesktopControlSession>>

/** The live conversation owner starts and revokes each exact binding. */
export class ControlSessions {
  private readonly sessions = new Map<string, Promise<Session>>()
  private readonly finishing = new Map<string, Promise<void>>()
  private closing: Promise<void> | undefined
  private readonly launches = new Map<string, ControlLaunch>()
  private readonly native: () => Promise<
    { driver: string; socket: string } | undefined
  >
  private readonly launchSession: typeof startDesktopControlSession
  constructor(
    native: () => Promise<{ driver: string; socket: string } | undefined>,
    launchSession = startDesktopControlSession
  ) {
    this.native = native
    this.launchSession = launchSession
  }

  async start(
    bindingId: string,
    browser?: ControlCredentials,
    onEnded: (reason: "stopped" | "failed") => Promise<void> = async () => {}
  ): Promise<ControlLaunch> {
    if (this.closing) throw new Error("Local Control supervisor is closing")
    if (this.sessions.has(bindingId) || this.finishing.has(bindingId))
      throw new Error("Local Control binding is already running")
    const pending = (async () =>
      this.launchSession(
        {
          taskId: bindingId,
          browser,
          native: await this.native(),
        },
        {
          onSpawn: (child) =>
            trackProviderChild(child, {
              kind: "local-control",
              owner: bindingId,
            }),
        }
      ))()
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
      throw error
    }
  }
  get(bindingId: string): ControlLaunch | undefined {
    return this.launches.get(bindingId)
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
    await (await pending?.catch(() => undefined))?.close()
    await this.finishing.get(bindingId)
  }
  close(): Promise<void> {
    return (this.closing ??= Promise.all(
      [...this.sessions.keys()]
        .map((id) => this.stop(id))
        .concat([...this.finishing.values()])
    ).then(() => {}))
  }
}

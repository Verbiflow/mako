import type { ControlLaunch } from "@mako/control-runtime/session"
import type { ControlSessions } from "./sessions.js"
import type { startControlService } from "./service.js"

/** How long a hibernated binding's Local Control session waits for its provider to wake. */
export const CONTROL_SLEEP_MS = 30 * 60_000

interface Dependencies<Grant> {
  sessions: Pick<ControlSessions, "get" | "startOptional" | "stop">
  /** The conversation MCP servers, once they listen: a provider's grant to them. */
  grants: () => { mint(bindingId: string, conversationId: string): Grant; revoke(bindingId: string, conversationId: string): void } | undefined
  /** Agents' browser access, once the conversations exist to authorize it. */
  browser: () => Pick<Awaited<ReturnType<typeof startControlService>>, "mint" | "revoke"> | undefined
  /** The JSONL file that gets a line for each of the conversation's Local Control requests. */
  journal: (conversationId: string) => string
  /** A message for the person; each distinct one is told once per host. */
  notice: (message: string) => void
  sleepMs?: number
}

/**
 * Which Local Control session each binding holds across its provider's life.
 * A provider's grant ends with its process, but hibernation keeps the session
 * (tabs, leases and program state) for the provider that wakes in its place,
 * for up to `CONTROL_SLEEP_MS`. Closing the conversation, a failed wake or the
 * timeout ends it.
 */
export class ControlResidency<Grant extends object> {
  private readonly sleeping = new Map<string, NodeJS.Timeout>()
  private readonly told = new Set<string>()
  private readonly dependencies: Dependencies<Grant>
  constructor(dependencies: Dependencies<Grant>) {
    this.dependencies = dependencies
  }

  /** A starting provider's grant, with the binding's kept session when it has one. */
  async tools(bindingId: string, conversationId: string): Promise<(Grant & { control?: ControlLaunch }) | undefined> {
    const { sessions, browser, notice } = this.dependencies
    const minted = this.dependencies.grants()?.mint(bindingId, conversationId)
    if (!minted) return undefined
    this.wake(bindingId)
    const kept = sessions.get(bindingId)
    if (kept) return { ...minted, control: kept }
    const started = await sessions.startOptional(bindingId, browser()?.mint(conversationId, bindingId), async (reason) => {
      await browser()?.revoke(conversationId, bindingId)
      if (reason === "failed") notice("Local Control stopped unexpectedly. Its browser access has ended; start a new task before continuing control.")
    }, this.dependencies.journal(conversationId))
    if ("launch" in started) return { ...minted, control: started.launch }
    await browser()?.revoke(conversationId, bindingId)
    if (!this.told.has(started.unavailable)) {
      this.told.add(started.unavailable)
      notice(started.unavailable)
    }
    return minted
  }

  /** The provider stopped for good: its grant and session end. */
  async revoke(bindingId: string, conversationId: string): Promise<void> {
    this.dependencies.grants()?.revoke(bindingId, conversationId)
    await this.stop(bindingId, conversationId)
  }

  /** The provider hibernated: its grant ends and its session waits. */
  async suspend(bindingId: string, conversationId: string): Promise<void> {
    this.dependencies.grants()?.revoke(bindingId, conversationId)
    if (!this.dependencies.sessions.get(bindingId)) return this.stop(bindingId, conversationId)
    this.wake(bindingId)
    const timer = setTimeout(() => void this.stop(bindingId, conversationId), this.dependencies.sleepMs ?? CONTROL_SLEEP_MS)
    timer.unref()
    this.sleeping.set(bindingId, timer)
  }

  /** Whether the binding's session is waiting for its provider to wake. */
  asleep(bindingId: string): boolean {
    return this.sleeping.has(bindingId)
  }

  private wake(bindingId: string) {
    clearTimeout(this.sleeping.get(bindingId))
    this.sleeping.delete(bindingId)
  }

  private async stop(bindingId: string, conversationId: string) {
    this.wake(bindingId)
    await this.dependencies.browser()?.revoke(conversationId, bindingId)
    await this.dependencies.sessions.stop(bindingId)
  }
}

import { AgentHost, defaultWorkspace } from "./host.js"
import type { HostEvent, TabSnapshot } from "./shared.js"

/**
 * The open tabs.
 *
 * Mako used to hold exactly one agent, and starting another tore the first one
 * down — so "branch this conversation and try the other answer" meant losing
 * the answer you already had. This holds several at once. Each tab is a whole
 * `AgentHost`: its own runtime, its own working directory, its own git root.
 * They stream concurrently; only the foreground one sends its transcript over
 * the wire.
 *
 * Commands from the UI always address the tab you are looking at, because that
 * is the only one with a composer in front of it. The pool's own surface is
 * therefore small: open, close, activate, and fork-into-a-new-tab.
 */
export class HostPool {
  private hosts: AgentHost[] = []
  private activeIndex = 0
  private counter = 0
  private readonly prefix = crypto.randomUUID()
  private emit: (event: HostEvent) => void

  constructor(emit: (event: HostEvent) => void) {
    this.emit = emit
  }

  /* -------------------------------------------------- access */

  get active(): AgentHost {
    const host = this.hosts[this.activeIndex]
    if (!host) throw new Error("No agent tab is open")
    return host
  }

  get activeId(): string {
    return this.active.id
  }

  get ids(): string[] {
    return this.hosts.map((host) => host.id)
  }

  /** The first tab, created on demand so boot has something to show. */
  async ensure(): Promise<AgentHost> {
    if (this.hosts.length === 0) await this.spawn(defaultWorkspace())
    return this.active
  }

  /* -------------------------------------------------- snapshots */

  snapshot(host: AgentHost): TabSnapshot {
    return {
      id: host.id,
      session: host.state(),
      capabilities: host.capabilities(),
    }
  }

  snapshots(): TabSnapshot[] {
    // Boot needs the conversation, not a completed Git scan. The renderer
    // requests Git separately once it has adopted these tabs.
    return this.hosts.map((host) => this.snapshot(host))
  }

  /* -------------------------------------------------- lifecycle */

  /**
   * Open a tab.
   *
   * Born in the background and brought forward once it is ready, so the window
   * never shows a half-started agent — and so the expensive first push happens
   * exactly once, on activation, rather than during startup.
   */
  async open(options: { cwd?: string; sessionPath?: string } = {}): Promise<TabSnapshot> {
    const host = await this.spawn(options.cwd ?? this.workspaceHint(), { activate: false })
    if (options.sessionPath) {
      try {
        await host.openSession(options.sessionPath)
      } catch (error) {
        // A tab that cannot open the session it was asked for is worse than no
        // tab: close it rather than stranding an empty one in the strip.
        await this.destroy(host)
        throw error
      }
    }
    this.focus(host)
    return this.snapshot(host)
  }

  /**
   * Branch a past turn of the active tab into a tab of its own.
   *
   * The fork runs on the *new* host, not the current one: it opens the same
   * session file, then forks from there. That leaves the original conversation
   * untouched — which is the entire promise of the feature, and would be
   * broken if we forked in place and re-opened the original afterwards.
   */
  async forkIntoTab(
    entryId: string,
    position: "before" | "at" = "before"
  ): Promise<{ cancelled: true } | { cancelled: false; text?: string; tab: TabSnapshot }> {
    const source = this.active
    const path = source.sessionFile
    if (!path) throw new Error("This conversation has not been saved yet, so it cannot be branched")

    const host = await this.spawn(source.workspace, { activate: false })
    try {
      await host.openSession(path)
      const result = await host.fork(entryId, position)
      if (result.cancelled) {
        await this.destroy(host)
        return { cancelled: true }
      }
      this.focus(host)
      return { cancelled: false, text: result.text, tab: await this.snapshot(host) }
    } catch (error) {
      await this.destroy(host)
      throw error
    }
  }

  activate(id: string): boolean {
    const index = this.hosts.findIndex((host) => host.id === id)
    if (index === -1 || index === this.activeIndex) return false
    this.active.setForeground(false)
    this.activeIndex = index
    this.active.setForeground(true)
    return true
  }

  /**
   * Close a tab, returning which one is now in front.
   *
   * Closing the last tab opens a fresh one rather than leaving the window with
   * nothing in it — there is no useful state where Mako has no conversation.
   * Focus moves to the neighbour on the right, matching every editor.
   */
  async close(id: string): Promise<{ tabs: string[]; activeId: string; opened?: TabSnapshot }> {
    const index = this.hosts.findIndex((host) => host.id === id)
    if (index === -1) return { tabs: this.ids, activeId: this.activeId }

    const [host] = this.hosts.splice(index, 1)
    const wasActive = index === this.activeIndex
    if (index < this.activeIndex) this.activeIndex -= 1
    if (host) await host.dispose()

    if (this.hosts.length === 0) {
      const opened = await this.open({ cwd: host?.workspace })
      return { tabs: this.ids, activeId: this.activeId, opened }
    }

    this.activeIndex = Math.min(this.activeIndex, this.hosts.length - 1)
    if (wasActive) this.active.setForeground(true)
    return { tabs: this.ids, activeId: this.activeId }
  }

  async dispose() {
    const hosts = this.hosts
    this.hosts = []
    await Promise.all(hosts.map((host) => host.dispose()))
  }

  /* -------------------------------------------------- internals */

  private workspaceHint(): string {
    return this.hosts.length > 0 ? this.active.workspace : defaultWorkspace()
  }

  private async spawn(cwd: string, { activate = true } = {}): Promise<AgentHost> {
    const host = new AgentHost(`tab-${this.prefix}-${++this.counter}`, this.emit)
    if (!activate) host.setForeground(false)
    await host.start(cwd)
    this.hosts.push(host)
    if (activate) {
      if (this.hosts.length > 1) this.hosts[this.activeIndex]?.setForeground(false)
      this.activeIndex = this.hosts.length - 1
      host.setForeground(true)
    }
    return host
  }

  private focus(host: AgentHost) {
    const index = this.hosts.indexOf(host)
    if (index === -1) return
    if (this.hosts[this.activeIndex] !== host) this.hosts[this.activeIndex]?.setForeground(false)
    this.activeIndex = index
    host.setForeground(true)
  }

  private async destroy(host: AgentHost) {
    const index = this.hosts.indexOf(host)
    if (index !== -1) this.hosts.splice(index, 1)
    if (index !== -1 && index < this.activeIndex) this.activeIndex -= 1
    this.activeIndex = Math.max(0, Math.min(this.activeIndex, this.hosts.length - 1))
    await host.dispose()
  }
}

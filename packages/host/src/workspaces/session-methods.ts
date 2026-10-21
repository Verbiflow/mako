import type { LiveSummary } from "../contracts/live-conversations.js"
import type { ThreadArchiveSnapshot } from "../contracts/thread-lifecycle.js"
import type { AgentHost } from "./agent-host.js"
import type { HostPool } from "./pool.js"
import type { BootPayload, TabSnapshot } from "../contracts/host-events-boot.js"
import type { ThinkingLevel } from "../contracts/conversation-session.js"
import type { MethodTable } from "../base/methods.js"
import type { MachineOffer } from "../contracts/machine-offer.js"
import type { ElsewhereFolder } from "./elsewhere.js"

export interface SessionMethodsDeps {
  archives?(): ThreadArchiveSnapshot
  liveSummaries(): LiveSummary[]
  ready(): Promise<HostPool>
  withHost<TResult>(
    operation: (host: AgentHost) => TResult | Promise<TResult>
  ): Promise<TResult>
  platform: NodeJS.Platform
  machine(): Promise<MachineOffer>
  sourceRoot?: string
  onWorkspaceChanged?(cwd: string): void | Promise<void>
  /** A conversation's folder on another host, when the conversation is one whose folder isn't on this Mac. */
  elsewhere?(conversation: string): Promise<ElsewhereFolder | undefined>
}

export function declareSessionMethods(methods: MethodTable, context: SessionMethodsDeps): void {
  const { ready, withHost } = context
  methods.handle("mako:boot", async (): Promise<BootPayload> => {
    const live = await ready()
    const [tabs, models, machine] = await Promise.all([
      live.snapshots(),
      live.active.listModels(),
      context.machine(),
    ])
    return {
      live: context.liveSummaries(),
      archives: context.archives?.(),
      tabs,
      activeTabId: live.activeId,
      models,
      platform: context.platform,
      machine,
      // Only when the renderer is coming from Vite: that is exactly the
      // condition under which an edit here shows up without a restart.
      sourceRoot: context.sourceRoot,
    }
  })

  methods.handle(
    "mako:open-tab",
    async (options?: { cwd?: string; sessionPath?: string }) => {
      const live = await ready()
      const opened = await live.open(options ?? {})
      await context.onWorkspaceChanged?.(opened.session.meta.cwd)
      return opened
    }
  )
  methods.handle("mako:close-tab", async (id: string) => {
    const live = await ready()
    const previous = live.activeId
    const result = await live.close(id)
    if (live.activeId !== previous)
      await context.onWorkspaceChanged?.(live.active.workspace)
    return result
  })
  methods.handle("mako:activate-tab", async (id: string) => {
    const live = await ready()
    const changed = live.activate(id)
    if (changed) await context.onWorkspaceChanged?.(live.active.workspace)
    return changed
  })

  methods.handle(
    "mako:list-sessions",
    (cwd?: string, scope?: "workspace" | "all") =>
      withHost((host) => host.listSessions(cwd, scope))
  )
  methods.handle("mako:open-session", (path: string) =>
    withHost(async (host) => {
      await host.openSession(path)
      return host.state()
    })
  )
  methods.handle("mako:new-session", () =>
    withHost(async (host) => {
      await host.newSession()
      return host.state()
    })
  )
  // `conversation`: the conversation whose folder this is, so one on another host is read there.
  methods.handle("mako:set-cwd", (cwd: string, conversation?: string) =>
    withHost(async (host): Promise<TabSnapshot> => {
      const elsewhere = conversation ? await context.elsewhere?.(conversation) : undefined
      await host.setCwd(cwd, elsewhere)
      if (!elsewhere) await context.onWorkspaceChanged?.(cwd)
      return {
        id: host.id,
        session: host.state(),
        capabilities: host.capabilities(),
      }
    })
  )
  methods.handle("mako:set-name", (name: string) =>
    withHost((host) => host.setName(name))
  )

  methods.handle(
    "mako:prompt",
    (
      text: string,
      mode?: "steer" | "followUp",
      images?: Array<{ mimeType: string; data: string }>
    ) => withHost((host) => host.prompt(text, mode, images))
  )
  methods.handle("mako:abort", () => withHost((host) => host.abort()))
  methods.handle("mako:clear-queue", () => withHost((host) => host.clearQueue()))
  // Branching opens a tab rather than replacing this one. Exploring the same
  // question two ways only works if both answers stay on screen.
  methods.handle(
    "mako:fork",
    async (entryId: string, position?: "before" | "at") => {
      const live = await ready()
      return live.forkIntoTab(entryId, position)
    }
  )
  methods.handle("mako:navigate-tree", (targetId: string) =>
    withHost(async (host) => {
      await host.navigateTree(targetId)
      return host.state()
    })
  )
  methods.handle("mako:compact", (instructions?: string) =>
    withHost((host) => host.compact(instructions))
  )
  methods.handle("mako:set-auto-compaction", (enabled: boolean) =>
    withHost((host) => host.setAutoCompaction(enabled))
  )

  methods.handle("mako:list-models", () => withHost((host) => host.listModels()))
  methods.handle("mako:set-model", (provider: string, id: string) =>
    withHost((host) => host.setModel(provider, id))
  )
  methods.handle("mako:set-thinking", (level: ThinkingLevel) =>
    withHost((host) => host.setThinking(level))
  )
  methods.handle("mako:capabilities", () =>
    withHost((host) => host.capabilities())
  )
  methods.handle("mako:set-active-tools", (names: string[]) =>
    withHost((host) => host.setActiveTools(names))
  )
  methods.handle("mako:run-command", (name: string, args?: string) =>
    withHost((host) => host.runCommand(name, args))
  )
}

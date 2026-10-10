import type { MethodTable } from "../host-methods.js"
import { startConversationMcp } from "../conversation-mcp.js"
import { deletePlugin, listPlugins, pluginsDir, watchPlugins, writePlugin } from "../plugins.js"
import { discoverMcpRegistry } from "../mcp-registry.js"
import { integrationCatalog } from "../integrations.js"
import { applyMcpSync, previewMcpSync } from "../mcp-sync.js"
import { nativeAuthoringCatalog, listNativeAuthoring, readNativeAuthoring, writeNativeAuthoring, removeNativeAuthoring } from "../native-authoring.js"
import type { NativeAuthoringTarget, NativeAuthoringWrite, NativeAuthoringRemove } from "@mako/host/contracts/native-authoring"
import { discoverSkillRegistry, resolveSkillReferences } from "../skill-registry.js"
import { applySkillSync, previewSkillRemove, previewSkillSync } from "../skill-sync.js"
import { workspaceTools, within } from "../workspace-tools.js"
import { pullRequestTools } from "../pull-request-tools.js"
import { githubStatus, listBranchPulls } from "../github.js"
import { cuaDriverStatus } from "../cua-driver-version.js"
import { resolveExecutable } from "@mako/host/base/executable"
import { computerPermissions } from "../computer-permissions.js"
import { presentMachine } from "@mako/host/base/machine"
import type { LiveConversations } from "../live-conversations.js"
import type { AgentHost } from "../host.js"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { McpSyncTarget, SkillSyncTarget } from "@mako/host/contracts/mcp-skills-integrations"
import type { Control } from "./control.js"
import type { Workspaces, WorkspaceMovers } from "./workspaces.js"

/** The `mako` server every agent calls: the workspace, its apps and its pull requests. */
export type ConversationTools = Awaited<ReturnType<typeof startConversationMcp>>

export interface ToolsDeps {
  live: LiveConversations
  control: Control
  workspaces: Workspaces
  movers: WorkspaceMovers
  emit(event: HostEvent): void
}

export function startTools({ live, control, workspaces, movers, emit }: ToolsDeps): Promise<ConversationTools> {
  const { worktrees } = workspaces
  const cwd = (id: string) => live.session(id)?.cwd
  // An agent's tool changed a branch or its pull request: windows read both again at once.
  const branchChanged = () => {
    worktrees?.forgetPulls()
    emit({ type: "worktrees-changed" })
    emit({ type: "github-changed" })
  }
  return startConversationMcp(
    live,
    (bindingId, operation, signal) => control.sessions.request(bindingId, operation, signal),
    workspaceTools({
      cwd,
      worktrees,
      moves: movers.moves,
      changed: branchChanged,
      pullsOf: listBranchPulls,
      recipesRoot: workspaces.recipes,
    }),
    movers.appTools,
    pullRequestTools({
      cwd,
      async startedFrom(id, folder) {
        const worktree = worktrees?.ofConversation(id)
        if (!worktree || !(await within(worktree.path, folder))) return null
        return (await worktrees?.startedFrom(worktree.path)) ?? null
      },
      changed: branchChanged,
    })
  )
}

/**
 * The agent writes a plugin with its ordinary file tools and every window
 * re-evaluates it: no IPC for it to learn, no command for the user to run.
 */
export function watchPluginChanges(emit: (event: HostEvent) => void): { close(): void } | null {
  return watchPlugins(() => emit({ type: "plugins-changed" }))
}

export interface ToolMethodsDeps {
  control: Control
  withHost<T>(run: (host: AgentHost) => T | Promise<T>): Promise<T>
}

/** Plugins, MCP servers, skills and each harness's own instructions, as people manage them. */
export function declareToolMethods(methods: MethodTable, { control, withHost }: ToolMethodsDeps): void {
  methods.handle("mako:list-plugins", () => listPlugins())
  methods.handle("mako:plugins-dir", () => pluginsDir())
  methods.handle("mako:write-plugin", (id: string, source: string) => writePlugin(id, source))
  methods.handle("mako:delete-plugin", (id: string) => deletePlugin(id))
  methods.handle("mako:reveal-plugins", async () => {
    await presentMachine().open(pluginsDir())
  })
  methods.handle("mako:mcp-discover", () => withHost((host) => discoverMcpRegistry(host.workspace)))
  methods.handle("mako:integrations", () =>
    withHost(async (host) => {
      await control.ensureLocalControl().catch(() => null)
      const [snapshot, github, driver, permissions] = await Promise.all([
        discoverMcpRegistry(host.workspace),
        githubStatus(host.workspace),
        cuaDriverStatus(resolveExecutable("cua-driver")),
        control.computerPermissions().catch(() => computerPermissions(undefined)),
      ])
      return integrationCatalog(snapshot, permissions, github.authenticated, control.browser.status(), driver)
    })
  )
  methods.handle("mako:mcp-sync-preview", (serverId: string, target: McpSyncTarget) =>
    withHost(async (host) => previewMcpSync(await discoverMcpRegistry(host.workspace), serverId, target))
  )
  methods.handle("mako:mcp-sync-apply", (serverId: string, target: McpSyncTarget) =>
    withHost(async (host) => {
      const snapshot = await discoverMcpRegistry(host.workspace)
      await applyMcpSync(snapshot, serverId, target)
      return discoverMcpRegistry(host.workspace)
    })
  )
  methods.handle("mako:skills-discover", () => withHost((host) => discoverSkillRegistry(host.workspace)))
  methods.handle("mako:native-authoring-catalog", () => withHost((host) => nativeAuthoringCatalog(host.workspace)))
  methods.handle("mako:native-authoring-list", (target: NativeAuthoringTarget) => withHost((host) => listNativeAuthoring(host.workspace, target)))
  methods.handle("mako:native-authoring-read", (target: NativeAuthoringTarget, id: string) => withHost((host) => readNativeAuthoring(host.workspace, target, id)))
  methods.handle("mako:native-authoring-write", (input: NativeAuthoringWrite) => withHost((host) => writeNativeAuthoring(host.workspace, input)))
  methods.handle("mako:native-authoring-remove", (input: NativeAuthoringRemove) => withHost((host) => removeNativeAuthoring(host.workspace, input)))
  methods.handle("mako:skills-resolve", (names: string[], harness: string) =>
    withHost(async (host) => resolveSkillReferences(await discoverSkillRegistry(host.workspace), names, harness))
  )
  methods.handle("mako:skills-sync-preview", (skillId: string, target: SkillSyncTarget) =>
    withHost(async (host) => previewSkillSync(await discoverSkillRegistry(host.workspace), skillId, target))
  )
  methods.handle("mako:skills-remove-preview", (skillId: string, target: SkillSyncTarget) =>
    withHost(async (host) => previewSkillRemove(await discoverSkillRegistry(host.workspace), skillId, target))
  )
  methods.handle("mako:skills-sync-apply", (skillId: string, targets: SkillSyncTarget[]) =>
    withHost(async (host) => {
      const snapshot = await discoverSkillRegistry(host.workspace)
      const source = snapshot.skills.find((skill) => skill.id === skillId)?.origins[0]
      const ordered = [...targets].sort((left, right) => {
        const matches = (target: SkillSyncTarget) =>
          source?.provider === target.provider &&
          source.account === target.account &&
          source.scope === target.scope
        return Number(matches(left)) - Number(matches(right))
      })
      for (const target of ordered) {
        await applySkillSync(snapshot, skillId, target)
      }
      return discoverSkillRegistry(host.workspace)
    })
  )
}

import { isAbsolute } from "node:path"
import type { MethodTable } from "../base/methods.js"
import { deletePlugin, listPlugins, pluginsDir, watchPlugins, writePlugin } from "./plugins.js"
import { mcpRegistry, type McpRegistry } from "./mcp-registry.js"
import { integrationCatalog } from "./integrations.js"
import { mcpSync, type McpSync } from "./mcp-sync.js"
import { nativeAuthoring, type NativeAuthoring } from "./native-authoring.js"
import type { NativeAuthoringTarget, NativeAuthoringWrite, NativeAuthoringRemove } from "../contracts/native-authoring.js"
import { resolveSkillReferences, skillRegistry, type SkillRegistry } from "./skill-registry.js"
import { skillSync, type SkillSync } from "./skill-sync.js"
import type { ToolHarnesses } from "./harnesses.js"
import { githubStatus } from "../git/index.js"
import { presentMachine, type MachineCapability } from "../base/machine.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { McpSyncTarget, SkillSyncTarget } from "../contracts/mcp-skills-integrations.js"
import type { Control } from "../control/index.js"

export { startConversationMcp, type ConversationMcp, type MakoTools, type ToolGrant } from "./conversation-mcp.js"
export type { Catalog, HarnessAccount, ToolHarnesses } from "./harnesses.js"
export type { ProviderMcpSource, McpJsonFormat } from "./mcp-source.js"
export { inEveryAncestor, scopedMcpWriteArgs } from "./mcp-source.js"
export type { ProviderSkillSource } from "./skill-source.js"
export type { ProviderAuthoringCapability, ProviderEditingCapability } from "./editing-capability.js"
export { acpMcpServers, codexMcpConfig, mergeCodexConfig, MAKO_TOOL_TIMEOUT_MS } from "./mcp-runtime.js"
export { unlaunchableMcpServers } from "./mcp-preflight.js"
export { migrateRetiredMakoMcpFile, removeRetiredMakoMcp } from "./retired-mcp.js"

/** Every harness's MCP servers, skills and native configuration, read and copied between them. */
export interface Tools {
  mcp: McpRegistry
  mcpSync: McpSync
  skills: SkillRegistry
  skillSync: SkillSync
  authoring: NativeAuthoring
}

export function openTools(harnesses: ToolHarnesses): Tools {
  const mcp = mcpRegistry(harnesses)
  const skills = skillRegistry(harnesses)
  return {
    mcp,
    mcpSync: mcpSync(harnesses, mcp),
    skills,
    skillSync: skillSync(harnesses, skills),
    authoring: nativeAuthoring(harnesses),
  }
}

export function watchPluginChanges(dataRoot: string, emit: (event: HostEvent) => void): { close(): void } | null {
  return watchPlugins(pluginsDir(dataRoot), () => emit({ type: "plugins-changed" }))
}

export interface ToolMethodsDeps {
  tools: Tools
  control: Control
  /** The folder of the tab in front. */
  workspace(): Promise<string>
  dataRoot: string
  machine: MachineCapability
}

/** Plugins, MCP servers, skills and each harness's own instructions, as people manage them. */
export function declareToolMethods(methods: MethodTable, { tools, control, workspace, dataRoot, machine }: ToolMethodsDeps): void {
  const { mcp, skills, authoring } = tools
  const plugins = pluginsDir(dataRoot)
  methods.handle("mako:list-plugins", () => listPlugins(plugins))
  methods.handle("mako:plugins-dir", () => plugins)
  methods.handle("mako:write-plugin", (id: string, source: string) => writePlugin(plugins, id, source))
  methods.handle("mako:delete-plugin", (id: string) => deletePlugin(plugins, id))
  methods.handle("mako:reveal-plugins", async () => {
    await presentMachine(machine).open(plugins)
  })
  methods.handle("mako:mcp-discover", () => workspace().then(mcp.discover))
  /** Someone is writing a new conversation's first message in `cwd`; listing its MCP servers now lets the launch find them cached. */
  methods.handle("mako:launch-prewarm", (cwd: string) => {
    if (isAbsolute(cwd)) void mcp.discover(cwd).catch(() => undefined)
  })
  methods.handle("mako:integrations", () =>
    workspace().then(async (cwd) => {
      await control.ensureLocalControl().catch(() => null)
      const [snapshot, github, driver, permissions] = await Promise.all([
        mcp.discover(cwd),
        githubStatus(cwd),
        control.driverStatus(),
        control.computerPermissions(),
      ])
      return integrationCatalog(snapshot, permissions, github.authenticated, control.browser.status(), driver)
    })
  )
  methods.handle("mako:mcp-sync-preview", (serverId: string, target: McpSyncTarget) =>
    workspace().then(async (cwd) => tools.mcpSync.preview(await mcp.discover(cwd), serverId, target))
  )
  methods.handle("mako:mcp-sync-apply", (serverId: string, target: McpSyncTarget) =>
    workspace().then(async (cwd) => {
      const snapshot = await mcp.discover(cwd)
      await tools.mcpSync.apply(snapshot, serverId, target)
      return mcp.discover(cwd)
    })
  )
  methods.handle("mako:skills-discover", () => workspace().then(skills.discover))
  methods.handle("mako:native-authoring-catalog", () => workspace().then(authoring.catalog))
  methods.handle("mako:native-authoring-list", (target: NativeAuthoringTarget) => workspace().then((cwd) => authoring.list(cwd, target)))
  methods.handle("mako:native-authoring-read", (target: NativeAuthoringTarget, id: string) => workspace().then((cwd) => authoring.read(cwd, target, id)))
  methods.handle("mako:native-authoring-write", (input: NativeAuthoringWrite) => workspace().then((cwd) => authoring.write(cwd, input)))
  methods.handle("mako:native-authoring-remove", (input: NativeAuthoringRemove) => workspace().then((cwd) => authoring.remove(cwd, input)))
  methods.handle("mako:skills-resolve", (names: string[], harness: string) =>
    workspace().then(async (cwd) => resolveSkillReferences(await skills.discover(cwd), names, harness))
  )
  methods.handle("mako:skills-sync-preview", (skillId: string, target: SkillSyncTarget) =>
    workspace().then(async (cwd) => tools.skillSync.preview(await skills.discover(cwd), skillId, target))
  )
  methods.handle("mako:skills-remove-preview", (skillId: string, target: SkillSyncTarget) =>
    workspace().then(async (cwd) => tools.skillSync.previewRemove(await skills.discover(cwd), skillId, target))
  )
  methods.handle("mako:skills-sync-apply", (skillId: string, targets: SkillSyncTarget[]) =>
    workspace().then(async (cwd) => {
      const snapshot = await skills.discover(cwd)
      const source = snapshot.skills.find((skill) => skill.id === skillId)?.origins[0]
      const ordered = [...targets].sort((left, right) => {
        const matches = (target: SkillSyncTarget) =>
          source?.provider === target.provider &&
          source.account === target.account &&
          source.scope === target.scope
        return Number(matches(left)) - Number(matches(right))
      })
      for (const target of ordered) {
        await tools.skillSync.apply(snapshot, skillId, target)
      }
      return skills.discover(cwd)
    })
  )
}

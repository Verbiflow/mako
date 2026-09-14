/* ------------------------------------------------------------------ */
/* MCP servers                                                         */
/* ------------------------------------------------------------------ */

export interface ToolSummary {
  name: string
  description?: string
  active: boolean
  source?: string
}

export interface CommandSummary {
  name: string
  description?: string
  source?: string
}

export interface SkillSummary {
  name: string
  description: string
  source?: string
}

export type SkillProvider = McpProvider | "agents"
export type SkillScope = "user" | "workspace"

export interface SkillOrigin {
  provider: SkillProvider
  account: string
  scope: SkillScope
  provenance: string
  /** This copy's package hash; differs from the record's when the copies have drifted apart. */
  hash: string
}

export interface SkillRecord {
  id: string
  name: string
  description: string
  hash: string
  bytes: number
  files: number
  portable: boolean
  origins: SkillOrigin[]
  license?: string
  compatibility?: string
  allowedTools?: string[]
  /**
   * `disable-model-invocation: true` in the frontmatter: only the user may
   * invoke it. A typed `$name` is exactly that invocation, so a handover
   * carries it like any other skill; the menu labels it `manual`.
   */
  manual?: boolean
  blockReason?: string
  conflict?: "name" | "drift"
}

export interface SkillProviderStatus {
  id: Exclude<SkillProvider, "agents">
  label: string
  account: string
  available: boolean
  /**
   * Whether the installed CLI loads `~/.agents/skills` and `.agents/skills`
   * on its own. Declared by the provider module and read as `false` until
   * verified against the CLI, so an unverified provider is handed the skill
   * in the prompt rather than trusted to find it.
   */
  readsUniversalRoot: boolean
}

/**
 * How a `$skill` typed into a message reaches the selected provider.
 *
 * `native`: the provider's own roots (or a universal root it is known to
 * read) hold the skill, so it loads it itself and the prompt only points at
 * it. `handover`: the skill lives somewhere this provider does not read, so
 * Mako carries the instructions inside the message and names the directory
 * that holds the skill's supporting files. `missing`: no skill of that name
 * anywhere Mako looks; the token goes out as typed.
 */
export type SkillDelivery =
  | { kind: "native"; path: string }
  | { kind: "handover"; path: string; from: SkillProvider }
  | { kind: "missing" }

/** One resolved `$skill` reference, ready to be written into a prompt. */
export interface SkillReference {
  name: string
  delivery: SkillDelivery
  description?: string
  hash?: string
  /** SKILL.md without its frontmatter; present for a handover within the size cap. */
  body?: string
  /** The body exceeded the cap, so the prompt points at SKILL.md instead of carrying it. */
  oversize?: boolean
}

export interface SkillRegistrySnapshot {
  cwd: string
  generatedAt: number
  skills: SkillRecord[]
  providers: SkillProviderStatus[]
}

export interface SkillSyncTarget {
  provider: Exclude<SkillProvider, "agents">
  account: string
  scope: SkillScope
}

export interface SkillSyncPreview {
  skillId: string
  target: SkillSyncTarget
  action: "add" | "replace" | "remove" | "unchanged" | "blocked"
  summary: string
  blockReason?: string
}

export interface Capabilities {
  tools: ToolSummary[]
  commands: CommandSummary[]
  skills: SkillSummary[]
}

/** Open provider id; MCP-capable harnesses register at host composition. */
export type McpProvider = string & {}
export type McpTransport = "stdio" | "http" | "sse"
export type McpScope = "user" | "workspace" | "effective" | "managed"

export interface McpRegistryProviderStatus {
  id: McpProvider
  label: string
  account: string
  available: boolean
  source: string
  detail?: string
}

export interface McpServerDefinition {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  envNames: string[]
  headerNames: string[]
  portable: boolean
  blockReason?: string
}

export interface McpServerOrigin {
  provider: McpProvider | "mako"
  account: string
  scope: McpScope
  provenance: string
}

export interface McpServerRecord extends McpServerDefinition {
  id: string
  origins: McpServerOrigin[]
  conflict?: "name" | "drift"
  availability?: "available" | "unavailable" | "unknown"
  detail?: string
  managed?: boolean
}

export interface McpRegistrySnapshot {
  cwd: string
  generatedAt: number
  servers: McpServerRecord[]
  providers: McpRegistryProviderStatus[]
}

export interface MakoComputerPermissions {
  supported: boolean
  persistentAcrossUpdates: boolean
  accessibility: boolean
  screenRecording:
    "not-determined" | "denied" | "restricted" | "granted" | "unknown"
}

/** Installed native computer-control driver against the release Mako verified. */
export interface CuaDriverStatus {
  executable: string | null
  version: string | null
  verified: string
  outdated: boolean
  detail: string
}

export type IntegrationCategory =
  "Communication" | "Planning" | "Development" | "Productivity" | "Local"

export type IntegrationConnection =
  | { kind: "connected"; detail: string; providers: McpProvider[] }
  | { kind: "ready"; detail: string }
  | { kind: "needs-permission"; detail: string }
  | { kind: "needs-update"; detail: string }
  | { kind: "setup"; detail: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "conflict"; detail: string }

export interface IntegrationRecord {
  id: string
  label: string
  description: string
  category: IntegrationCategory
  trust: "official" | "mako" | "community"
  auth:
    | "provider-oauth"
    | "provider-cli"
    | "local-browser"
    | "local-permission"
    | "mako-backend"
  capabilities: string[]
  events: string[]
  connection: IntegrationConnection
  setupUrl?: string
}

export interface IntegrationCatalogSnapshot {
  generatedAt: number
  integrations: IntegrationRecord[]
}

export interface McpSyncTarget {
  provider: McpProvider
  account: string
  scope: "user" | "workspace"
}

export interface McpSyncPreview {
  serverId: string
  target: McpSyncTarget
  action: "add" | "replace" | "unchanged" | "blocked"
  summary: string
  blockReason?: string
}

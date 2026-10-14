import type { NativeAuthoringFamily } from "../contracts/native-authoring.js"
import type { ProviderAuthoringCapability, ProviderEditingCapability, ProviderMcpEditing } from "./editing-capability.js"
import type { ProviderMcpSource } from "./mcp-source.js"
import type { ProviderSkillSource } from "./skill-source.js"

/** What each harness declared of one kind, by the harness. */
export interface Catalog<T extends { provider: string }> {
  get(provider: string): T | undefined
  list(): T[]
}

/** The account a harness runs as: its name, and its own folder when it isn't the harness's default. */
export interface HarnessAccount {
  name: string
  dir?: string
}

/**
 * What Tools reads of the harnesses: where each keeps its MCP servers, skills
 * and native configuration, which of them Mako may edit, and the account
 * each runs as.
 */
export interface ToolHarnesses {
  readonly mcpSources: Catalog<ProviderMcpSource>
  readonly skillSources: Catalog<ProviderSkillSource>
  readonly mcpEditing: Catalog<ProviderMcpEditing>
  readonly skillEditing: Catalog<ProviderEditingCapability>
  readonly authoring: Readonly<Record<NativeAuthoringFamily, Catalog<ProviderAuthoringCapability>>>
  /** Every installed harness, with why it has no authoring of a family, under the family its definition names. */
  readonly harnesses: Catalog<{ provider: string; absent: Partial<Record<"hooks" | "commands" | "mcpEditing", { absent: "harness" | "mako"; reason: string }>> }>
  label(provider: string): string
  /** The selected account and the environment the harness runs with, read without its sign-in. */
  account(provider: string): Promise<{ env: NodeJS.ProcessEnv; account: HarnessAccount }>
}

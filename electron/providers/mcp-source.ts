import type {
  McpScope,
  McpServerDefinition,
} from "../shared.js"
import type { ProviderCapability } from "./registry.js"

export interface ProviderAccountLocation {
  name: string
  dir?: string
}

export function scopedMcpWriteArgs(
  definition: McpServerDefinition,
  scope: Extract<McpScope, "user" | "workspace">,
  environment: Record<string, string>
): string[] {
  const scopeArgs = ["--scope", scope === "workspace" ? "project" : "user"]
  if (definition.transport === "stdio") {
    const envArgs = Object.entries(environment).flatMap(([name, value]) => [
      "-e",
      `${name}=${value}`,
    ])
    return [
      "mcp",
      "add",
      ...scopeArgs,
      ...envArgs,
      definition.name,
      "--",
      definition.command ?? "",
      ...(definition.args ?? []),
    ]
  }
  return [
    "mcp",
    "add",
    ...scopeArgs,
    "--transport",
    definition.transport,
    definition.name,
    definition.url ?? "",
  ]
}

export type McpReadFormat = "named-map" | "named-map-or-list" | "command-array-map"

export interface ProviderMcpSource extends ProviderCapability {
  readFormat: McpReadFormat
  command(env: NodeJS.ProcessEnv): string | null
  userFiles(account: ProviderAccountLocation): string[]
  workspaceFiles(cwd: string): string[]
  readsCli: boolean
  write:
    | { kind: "none" }
    | { kind: "file"; format: "claude" | "cursor" | "opencode" }
    | {
        kind: "cli"
        scopes: "user" | "both"
        args(
          definition: McpServerDefinition,
          scope: Extract<McpScope, "user" | "workspace">,
          environment: Record<string, string>
        ): string[]
      }
}

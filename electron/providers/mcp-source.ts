import { dirname, join, resolve } from "node:path"
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

/** `relative` inside `cwd` and inside every folder above it, nearest first. */
export function inEveryAncestor(cwd: string, relative: string): string[] {
  const files: string[] = []
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    files.push(join(folder, relative))
    if (dirname(folder) === folder) return files
  }
}

export type McpReadFormat = "named-map" | "named-map-or-list" | "command-array-map"

/** How a harness's JSON config holds MCP servers; Mako writes whichever format a harness declares. */
export interface McpJsonFormat {
  /** The key the servers sit under. */
  root: string
  /** A local server's command: one string with `args` beside it, or one array holding both. */
  command: "string" | "array"
  /** How a remote server is told apart: `type` names its transport, a `url` alone says it, or `type: "remote"`. */
  remote: "transport" | "implicit" | "remote"
}

export interface ProviderMcpSource extends ProviderCapability {
  readFormat: McpReadFormat
  command(env: NodeJS.ProcessEnv): string | null
  userFiles(account: ProviderAccountLocation): string[]
  workspaceFiles(cwd: string): string[]
  /**
   * Set when the harness's own CLI is what reads its MCP config (`<command> mcp list --json`).
   * `inputs` names every file that listing reads; Mako reuses the listing until one of them changes.
   */
  cliList: { inputs(env: NodeJS.ProcessEnv, cwd: string): string[] } | null
  /** How long Mako waits on one of its own MCP calls the harness makes, when the harness allows longer than a minute. */
  callWaitMs?: number
  write:
    | { kind: "none" }
    | { kind: "file"; format: McpJsonFormat }
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

import type { ProviderMcpSource } from "../mcp-source.js"

export const codexMcpSource: ProviderMcpSource = {
  provider: "codex",
  readFormat: "named-map-or-list",
  command: () => "codex",
  userFiles: () => [],
  workspaceFiles: () => [],
  readsCli: true,
  write: {
    kind: "cli",
    scopes: "user",
    args(definition, _scope, environment) {
      if (definition.transport === "stdio") {
        const envArgs = Object.entries(environment).flatMap(([name, value]) => [
          "--env",
          `${name}=${value}`,
        ])
        return [
          "mcp",
          "add",
          ...envArgs,
          definition.name,
          "--",
          definition.command ?? "",
          ...(definition.args ?? []),
        ]
      }
      return ["mcp", "add", definition.name, "--url", definition.url ?? ""]
    },
  },
}

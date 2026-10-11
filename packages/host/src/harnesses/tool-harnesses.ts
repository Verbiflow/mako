import type { ToolHarnesses } from "../tools/index.js"
import { harnessLabel } from "./harness-descriptors.js"
import type { ProviderHost } from "./host.js"

/** What the harnesses in `host` declared for Tools. Reading MCP or skill config needs no credentials, so no sign-in is read. */
export function toolHarnesses(host: ProviderHost): ToolHarnesses {
  return {
    mcpSources: host.mcpSources,
    skillSources: host.skillSources,
    mcpEditing: host.mcpEditing,
    skillEditing: host.skillEditing,
    authoring: { hooks: host.hooks, commands: host.commands },
    harnesses: host.harnesses,
    label: (provider) => harnessLabel(host, provider),
    account: (provider) => host.accounts.launch(provider, process.env, { trackCredential: false }),
  }
}

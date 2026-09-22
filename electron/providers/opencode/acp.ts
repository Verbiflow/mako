import { z } from "zod"
import { OpenCodeAgents } from "./agents.js"
import type { ProviderAcpSource } from "../acp-source.js"
import type { AccessTier } from "../../contracts/access.js"
import {
  openCodeInstallation,
  openCodeSessionGeneration,
} from "./installation.js"

interface OpenCodeAcpConfig {
  model?: string
  agent?: { build: { variant: string } }
}

/**
 * OpenCode decides what to ask through its `permission` config; the ACP
 * server only forwards the asks that config leaves open. Read-only tools and
 * questions never wait. The inline `OPENCODE_PERMISSION` overlay is read at
 * process start, so the ladder is fixed for the session's life; the host can
 * still answer the remaining asks for the tiers it enforces.
 */
function openCodePermission(access: AccessTier): string | undefined {
  const open = { read: "allow", glob: "allow", grep: "allow", list: "allow", question: "allow", todowrite: "allow", lsp: "allow" }
  switch (access) {
    case "ask":
      return JSON.stringify({ "*": "ask", ...open })
    case "edits":
      return JSON.stringify({ "*": "ask", ...open, edit: "allow" })
    case "full":
      return JSON.stringify("allow")
    default:
      return undefined
  }
}

export const openCodeAcpSource: ProviderAcpSource = {
  provider: "opencode",
  async observeAgents(input) {
    const observer = new OpenCodeAgents(input)
    await observer.ready
    return observer
  },
  compaction: { kind: "supported", command: "/compact", completion: { kind: "response" } },
  canResume: true,
  launchOptionIds: ["effort"],
  access: {
    native: { plan: "plan" },
    launch: ["ask", "edits", "full"],
    host: ["edits", "full"],
    base: "build",
    // OpenCode opens in "build" and reports it through the mode config option;
    // the ask overlay matches what build asks about by default.
    default: "ask",
  },
  nativeModes: [
    { id: "build", name: "build" },
    { id: "plan", name: "plan" },
  ],
  available: () => openCodeInstallation() !== null,
  async launch(options) {
    const generation = options.resume
      ? await openCodeSessionGeneration(options.resume)
      : openCodeInstallation()?.generation
    const installation = openCodeInstallation(generation)
    if (!installation) return null
    return {
      command: installation.command,
      args: ["acp"],
      configureEnvironment(env) {
        const permission = options.access ? openCodePermission(options.access) : undefined
        if (permission) env.OPENCODE_PERMISSION = permission
        if ((generation ?? installation.generation) === "v2" || !options.tuning)
          return
        const config: OpenCodeAcpConfig = {}
        if (options.tuning.model) config.model = options.tuning.model
        const effort = z.string().optional().parse(options.tuning.options?.effort)
        if (effort) config.agent = { build: { variant: effort } }
        if (Object.keys(config).length > 0) {
          env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
        }
      },
    }
  },
}

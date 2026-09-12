import { prepareDevinMcp } from "./session-mcp.js"
import { devinResumePolicy } from "./resume.js"
import type { ProviderAcpSource } from "../acp-source.js"
import { devinExecutable } from "./executable.js"
import { devinPermissionTitle } from "./permissions.js"
import { configureDevinEnvironment } from "./environment.js"

export const devinAcpSource: ProviderAcpSource = {
  ...devinResumePolicy(),
  provider: "devin",
  canResume: true,
  steering: "concurrent-prompt",
  access: {
    native: { edits: "accept-edits", auto: "smart", chat: "ask", plan: "plan", full: "bypass" },
  },
  nativeModes: [
    { id: "accept-edits", name: "Code" },
    { id: "smart", name: "Smart" },
    { id: "ask", name: "Ask" },
    { id: "plan", name: "Plan" },
    { id: "bypass", name: "Bypass Permissions" },
  ],
  available: () => devinExecutable() !== null,
  async launch() {
    return {
      command: devinExecutable() ?? "devin",
      args: ["acp"],
      configureEnvironment: configureDevinEnvironment,
      permissionTitle: devinPermissionTitle,
      prepareMcp: prepareDevinMcp,
    }
  },
}

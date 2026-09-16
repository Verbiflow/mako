import { acpLiveDriver } from "../acp-live-driver.js"
import type { ProviderModule } from "../host.js"
import { devinAcpSource } from "./acp.js"
import { devinMcpSource } from "./mcp.js"
import { devinNativeRunner } from "./native-runner.js"
import { devinProfileLoader } from "./profile.js"
import { devinSkillSource } from "./skills.js"
import { devinExecutable } from "./executable.js"

export const installDevin: ProviderModule = (host) => {
  host.nativeRunners.register(devinNativeRunner)
  host.acpSources.register(devinAcpSource)
  host.liveDrivers.register(acpLiveDriver(devinAcpSource))
  host.profiles.register(devinProfileLoader)
  host.mcpSources.register(devinMcpSource)
  host.skillSources.register(devinSkillSource)
  // Zed installs its own copy under its external-agents registry and
  // replaces it on its schedule; `devin update` asks before it installs, so
  // it is not run unattended.
  host.updateSources.register({
    provider: "devin",
    binary: () => devinExecutable(),
    managedBy: [["external_agents", "Zed"]],
  })
}

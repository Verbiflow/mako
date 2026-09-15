import { acpLiveDriver } from "../acp-live-driver.js"
import type { ProviderModule } from "../host.js"
import { devinAcpSource } from "./acp.js"
import { devinMcpSource } from "./mcp.js"
import { devinNativeRunner } from "./native-runner.js"
import { devinProfileLoader } from "./profile.js"
import { devinSkillSource } from "./skills.js"
import { cliUpdateSource } from "../update-source.js"
import { devinExecutable } from "./executable.js"

export const installDevin: ProviderModule = (host) => {
  host.nativeRunners.register(devinNativeRunner)
  host.acpSources.register(devinAcpSource)
  host.liveDrivers.register(acpLiveDriver(devinAcpSource))
  host.profiles.register(devinProfileLoader)
  host.mcpSources.register(devinMcpSource)
  host.skillSources.register(devinSkillSource)
  host.updateSources.register(
    cliUpdateSource("devin", {
      binary: () => devinExecutable(),
      managedBy: [["external_agents", "Zed"]],
    })
  )
}

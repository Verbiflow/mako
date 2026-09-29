import { acpLiveDriver } from "../acp-live-driver.js"
import type { ProviderModule } from "../host.js"
import { devinAcpSource } from "./acp.js"
import { devinMcpSource } from "./mcp.js"
import { devinNativeRunner } from "./native-runner.js"
import { devinProfileLoader } from "./profile.js"
import { devinSkillSource } from "./skills.js"
import { devinExecutable } from "./executable.js"
import { scriptInstall } from "../update-source.js"

export const installDevin: ProviderModule = (host) => {
  host.nativeRunners.register(devinNativeRunner)
  host.acpSources.register(devinAcpSource)
  host.liveDrivers.register(acpLiveDriver(devinAcpSource))
  host.profiles.register(devinProfileLoader)
  host.mcpSources.register(devinMcpSource)
  host.skillSources.register(devinSkillSource)
  // Devin.app and Zed each replace their bundled copy on their own schedule;
  // `devin update` asks before it installs, so it is not run unattended.
  host.updateSources.register({
    provider: "devin",
    binary: (env) => devinExecutable(env),
    managedBy: [["external_agents", "Zed"]],
    install: [scriptInstall("https://cli.devin.ai/install.sh")],
  })
}

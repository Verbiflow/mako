import { acpLiveDriver } from "../acp-live-driver.js"
import type { ProviderModule } from "../host.js"
import { openCodeAcpSource } from "./acp.js"
import { openCodeAccountCapability } from "./accounts.js"
import { openCodeMcpSource } from "./mcp.js"
import { openCodeNativeRunner } from "./native-runner.js"
import { openCodeProcessProbe } from "./process-probe.js"
import { openCodeProfileLoader } from "./profile.js"
import { openCodeSkillSource } from "./skills.js"
import { openCodeExecutable } from "./installation.js"

export const installOpenCode: ProviderModule = (host) => {
  host.accountCapabilities.register(openCodeAccountCapability)
  host.nativeRunners.register(openCodeNativeRunner)
  host.acpSources.register(openCodeAcpSource)
  host.liveDrivers.register(acpLiveDriver(openCodeAcpSource))
  host.profiles.register(openCodeProfileLoader)
  host.processProbes.register(openCodeProcessProbe)
  host.mcpSources.register(openCodeMcpSource)
  host.skillSources.register(openCodeSkillSource)
  // The install script puts the binary under ~/.opencode/bin; `opencode
  // upgrade` owns that install, npm and Homebrew own theirs.
  host.updateSources.register({
    provider: "opencode",
    binary: () => openCodeExecutable(),
    npmPackage: "opencode-ai",
    homebrew: { name: "opencode" },
    native: {
      label: "Update OpenCode",
      args: ["upgrade"],
      ownsPath: (path) => path.includes("/.opencode/bin/"),
    },
  })
}

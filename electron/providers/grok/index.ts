import { acpLiveDriver } from "../acp-live-driver.js"
import { emitGrokSession } from "@mako/sessions"
import type { ProviderModule } from "../host.js"
import { grokAcpSource } from "./acp.js"
import { grokMcpSource } from "./mcp.js"
import { grokNativeRunner } from "./native-runner.js"
import { grokProcessProbe } from "./process-probe.js"
import { grokProfileLoader } from "./profile.js"
import { grokSkillSource } from "./skills.js"
import { cliUpdateSource } from "../update-source.js"
import { resolveExecutable } from "../../executable.js"

export const installGrok: ProviderModule = (host) => {
  host.nativeRunners.register(grokNativeRunner)
  host.acpSources.register(grokAcpSource)
  host.liveDrivers.register(acpLiveDriver(grokAcpSource))
  host.profiles.register(grokProfileLoader)
  host.processProbes.register(grokProcessProbe)
  host.mcpSources.register(grokMcpSource)
  host.skillSources.register(grokSkillSource)
  host.sessionEmitters.register({
    provider: "grok",
    emit: (thread) => emitGrokSession(thread, {}),
  })
  host.updateSources.register(
    cliUpdateSource("grok", {
      binary: (env) => resolveExecutable("grok", env),
      npmPackage: "@xai-official/grok",
      selfUpdate: { label: "Update Grok", command: "grok", args: ["update"] },
    })
  )
}

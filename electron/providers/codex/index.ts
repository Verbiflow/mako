import { codexLiveDriver } from "./live-driver.js"
import { emitCodexSession } from "@mako/sessions"
import type { ProviderModule } from "../host.js"
import { codexAccountCapability } from "./accounts.js"
import { codexMcpSource } from "./mcp.js"
import { codexNativeRunner } from "./native-runner.js"
import { codexProcessProbe } from "./process-probe.js"
import { codexProfileLoader } from "./profile.js"
import { codexSkillSource } from "./skills.js"
import { cliUpdateSource } from "../update-source.js"
import { resolveCodexExecutable } from "./executable.js"

export const installCodex: ProviderModule = (host) => {
  host.liveDrivers.register(codexLiveDriver)
  host.accountCapabilities.register(codexAccountCapability)
  host.nativeRunners.register(codexNativeRunner)
  host.profiles.register(codexProfileLoader)
  host.processProbes.register(codexProcessProbe)
  host.mcpSources.register(codexMcpSource)
  host.skillSources.register(codexSkillSource)
  host.sessionEmitters.register({
    provider: "codex",
    emit: (thread) => emitCodexSession(thread, {}),
  })
  // No self-updater: the npm CLI upgrades through npm, the bundled one
  // arrives with Codex.app, and `codex` on PATH could be either.
  host.updateSources.register(
    cliUpdateSource("codex", {
      binary: (env) => resolveCodexExecutable(env),
      npmPackage: "@openai/codex",
    })
  )
}

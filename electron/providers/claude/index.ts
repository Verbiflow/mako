import { emitClaudeSession } from "@mako/sessions"
import type { ProviderModule } from "../host.js"
import { claudeLiveDriver } from "./live-driver.js"
import { claudeAccountCapability } from "./accounts.js"
import { claudeMcpSource } from "./mcp.js"
import { claudeNativeRunner } from "./native-runner.js"
import { claudeProcessProbe } from "./process-probe.js"
import { claudeProfileLoader } from "./profile.js"
import { claudeSkillSource } from "./skills.js"
import { cliUpdateSource } from "../update-source.js"
import { resolveExecutable } from "../../executable.js"

export const installClaude: ProviderModule = (host) => {
  host.accountCapabilities.register(claudeAccountCapability)
  host.nativeRunners.register(claudeNativeRunner)
  host.liveDrivers.register(claudeLiveDriver)
  host.profiles.register(claudeProfileLoader)
  host.processProbes.register(claudeProcessProbe)
  host.mcpSources.register(claudeMcpSource)
  host.skillSources.register(claudeSkillSource)
  host.sessionEmitters.register({
    provider: "claude",
    emit: (thread) => emitClaudeSession(thread, {}),
  })
  host.updateSources.register(
    cliUpdateSource("claude", {
      binary: (env) =>
        resolveExecutable(env.CLAUDE_CODE_EXECUTABLE ?? "claude", env),
      npmPackage: "@anthropic-ai/claude-code",
      selfUpdate: {
        label: "Update Claude Code",
        command: "claude",
        args: ["update"],
      },
    })
  )
}

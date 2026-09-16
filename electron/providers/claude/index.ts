import { emitClaudeSession } from "@mako/sessions"
import type { ProviderModule } from "../host.js"
import { claudeLiveDriver } from "./live-driver.js"
import { claudeAccountCapability } from "./accounts.js"
import { claudeMcpSource } from "./mcp.js"
import { claudeNativeRunner } from "./native-runner.js"
import { claudeProcessProbe } from "./process-probe.js"
import { claudeProfileLoader } from "./profile.js"
import { claudeSkillSource } from "./skills.js"
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
  // The native installer keeps versions under ~/.local/share/claude and links
  // ~/.local/bin/claude at the current one; `claude update` owns that layout
  // and refuses an npm install, which updates through npm.
  host.updateSources.register({
    provider: "claude",
    binary: (env) =>
      resolveExecutable(env.CLAUDE_CODE_EXECUTABLE ?? "claude", env),
    npmPackage: "@anthropic-ai/claude-code",
    homebrew: { name: "claude-code", cask: true },
    native: {
      label: "Update Claude Code",
      args: ["update"],
      ownsPath: (path) =>
        path.includes("/.local/share/claude/") ||
        path.endsWith("/.local/bin/claude") ||
        path.includes("/.claude/local/"),
    },
  })
}

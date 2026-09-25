import { emitClaudeSession } from "@mako/sessions"
import type { ProviderModule } from "../host.js"
import { claudeLiveDriver } from "./live-driver.js"
import { claudeAccountCapability } from "./accounts.js"
import { claudeMcpSource } from "./mcp.js"
import { claudeNativeRunner } from "./native-runner.js"
import { claudeProcessProbe } from "./process-probe.js"
import { claudeProfileLoader } from "./profile.js"
import { claudeSkillSource } from "./skills.js"
import type { RuntimeUpdateSource } from "../update-source.js"
import { claudeRuntime, terminalClaudeExecutable } from "./runtime.js"

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
  // The row sessions run first; the user's own `claude` is shown beside it
  // with its own updater, because updating it does not change sessions.
  host.updateSources.register({
    provider: "claude",
    primary: true,
    binary: (env) => claudeRuntime(env)?.executable ?? null,
    ...claudeReleasePolicy,
    installations: [
      {
        id: "terminal",
        label: "Claude Code CLI",
        binary: terminalClaudeExecutable,
        ...claudeReleasePolicy,
      },
    ],
  })
}

const claudeReleasePolicy = {
  npmPackage: "@anthropic-ai/claude-code",
  homebrew: { name: "claude-code", cask: true },
  // The native installer keeps versions under ~/.local/share/claude and links
  // ~/.local/bin/claude at the current one; `claude update` owns that layout
  // and refuses an npm install, which updates through npm.
  native: {
    label: "Update Claude Code",
    args: ["update"],
    ownsPath: (path: string) =>
      path.includes("/.local/share/claude/") ||
      path.endsWith("/.local/bin/claude") ||
      path.includes("/.claude/local/"),
  },
  // The Agent SDK's build changes only with the SDK version Mako ships.
  managedBy: [["/@anthropic-ai/claude-agent-sdk-", "Mako"]],
} satisfies Omit<RuntimeUpdateSource, "binary">

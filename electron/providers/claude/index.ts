import { emitClaudeSession } from "@mako/sessions"
import { installHarness, lacks } from "../harness-definition.js"
import type { ProviderModule } from "../host.js"
import { claudeLiveDriver } from "./live-driver.js"
import { claudeDecoderSource } from "./decoder-source.js"
import { claudeAccountCapability } from "./accounts.js"
import { claudeMcpSource } from "./mcp.js"
import { claudeNativeRunner } from "./native-runner.js"
import { claudeProcessProbe } from "./process-probe.js"
import { claudeProfileLoader } from "./profile.js"
import { claudeSkillSource } from "./skills.js"
import type { RuntimeUpdateSource } from "../update-source.js"
import { claudeRuntime, terminalClaudeExecutable } from "./runtime.js"

export const installClaude: ProviderModule = (host) => installHarness(host, {
  provider: "claude",
  live: claudeLiveDriver,
  decoder: claudeDecoderSource,
  profile: claudeProfileLoader,
  accounts: claudeAccountCapability,
  acp: lacks("Runs on the Claude Agent SDK"),
  nativeRunner: claudeNativeRunner,
  processProbe: claudeProcessProbe,
  mcp: claudeMcpSource,
  skills: claudeSkillSource,
  sessionEmitter: {
    provider: "claude",
    emit: (thread) => emitClaudeSession(thread, {}),
  },
  connection: lacks("Signs in through Claude Code’s own login"),
  // The row sessions run first; the user's own `claude` is shown beside it
  // with its own updater, because updating it does not change sessions.
  updates: {
    provider: "claude",
    primary: true,
    binary: (env) => claudeRuntime(env)?.executable ?? null,
    ...claudeReleasePolicy,
    // Sessions run the Claude Code build the Agent SDK ships inside Mako.
    install: [],
    installations: [
      {
        id: "terminal",
        label: "Claude Code CLI",
        binary: terminalClaudeExecutable,
        ...claudeReleasePolicy,
      },
    ],
  },
  artifactPreview: lacks("Writes no artifact Mako previews"),
})

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

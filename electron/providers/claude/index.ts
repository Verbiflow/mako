import { emitClaudeSession } from "@mako/sessions"
import { installHarness, lacks } from "../harness-definition.js"
import { byDefault, harnessLacks, implemented, makoLacks, noOp } from "../live-capabilities.js"
import { shownBy } from "../../contracts/harness-unique.js"
import { claudeHooks, claudeCommands } from "./authoring.js"
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
import { claudeUsageHistory } from "./usage-history.js"
import { claudePresentation } from "./presentation.js"
import { CLAUDE_AUTH_LOG } from "./auth-diagnostics.js"

export const installClaude: ProviderModule = (host) => installHarness(host, {
  provider: "claude",
  presentation: claudePresentation,
  diagnostics: { sdk: "@anthropic-ai/claude-agent-sdk", signInLog: CLAUDE_AUTH_LOG },
  usage: {
    context: implemented("The main agent's last call: what it read, cached or not, and wrote."),
    window: implemented("The answering model's `contextWindow` in each result's `modelUsage`."),
    compaction: implemented("The compact boundary's `post_tokens`."),
    tokens: implemented("Each result's session totals, less what the process had counted before."),
    cost: implemented("Each result's `total_cost_usd`, less what the process had counted before."),
    missedCalls: harnessLacks("Claude Code's results never say they left a call out."),
    resetCredits: harnessLacks("Claude's usage report has no reset credits."),
  },
  unique: [
    { name: "Context breakdown", native: "`getContextUsage`: categories, memory files, MCP tools, messages", mako: shownBy("capabilities.contextBreakdown") },
    { name: "Checkpoints", native: "`rewindFiles(userMessageId)`, `/rewind`", mako: noOp("Mako's own workspace checkpoints rewind files for every harness, so Mako doesn't use Claude's.") },
    { name: "Output styles", native: "`~/.claude/output-styles`, `.claude/output-styles`; `outputStyle`", mako: byDefault("Claude Code applies the output style its settings name in sessions Mako starts.") },
    { name: "Plugins", native: "`.claude-plugin/plugin.json` and marketplaces", mako: byDefault("Claude Code loads the plugins its settings enable in sessions Mako starts.") },
    { name: "Background agents", native: "`claude --bg`, `claude agents`", mako: makoLacks("Mako doesn't list or attach to Claude's background agents.") },
  ],
  hooks: claudeHooks,
  commands: claudeCommands,
  toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
  skillEditing: { provider: "claude", route: "skill-registry", operations: ["import", "remove"] },
  mcpEditing: { provider: "claude", route: "mcp-registry", operations: ["import"] },
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
    // Loaded on use: `accounts` reaches the provider registry this module is part of.
    emit: async (thread) => {
      const { accountEnv } = await import("../../accounts.js")
      return emitClaudeSession(thread, { store: (await accountEnv("claude", process.env)).CLAUDE_CONFIG_DIR || undefined })
    },
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
  usageHistory: claudeUsageHistory,  artifactPreview: lacks("It writes no artifact files of its own; the file viewer previews what it writes by file type."),
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

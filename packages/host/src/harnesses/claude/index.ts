import { emitClaudeSession } from "@mako/sessions"
import { installHarness, lacks } from "../harness-definition.js"
import { byDefault, harnessLacks, implemented, makoLacks } from "../live-capabilities.js"
import { makosOwn, native, shownAs, TOOL_ROWS } from "../../contracts/harness-features.js"
import { createClaudeCommands, createClaudeHooks } from "./authoring.js"
import type { ProviderModule } from "../host.js"
import { createClaudeLiveDriver } from "./live-driver.js"
import { claudeDecoderSource } from "./decoder-source.js"
import { claudeAccountCapability } from "./accounts.js"
import { claudeMcpSource } from "./mcp.js"
import { claudeNativeRunner } from "./native-runner.js"
import { claudeProcessProbe } from "./process-probe.js"
import { createClaudeProfileLoader } from "./profile.js"
import { claudeSkillSource } from "./skills.js"
import type { RuntimeUpdateSource } from "../update-source.js"
import { claudeRuntime, terminalClaudeExecutable } from "./runtime.js"
import { claudeUsageHistory } from "./usage-history.js"
import { claudePresentation } from "./presentation.js"
import { CLAUDE_AUTH_LOG } from "./auth-diagnostics.js"

export const installClaude: ProviderModule = (host, context) => installHarness(host, {
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
    balance: implemented("Extra usage left beyond the plan, in Claude's usage report."),
  },
  features: {
    goals: { native: native("/goal", "`/goal <condition>`, which runs without a terminal too; the `ProposeGoal` tool; `active_goal` messages with the condition and its iterations"), mako: shownAs("`/goal` and the goal bar send Claude's `/goal`, and the bar reads the transcript's `goal_status` records. Claude has no pause, so pausing clears the goal and resuming sets it again.") },
    review: { native: native("/security-review, /ultrareview", "`/security-review` of the branch's pending changes; `/ultrareview` in a cloud session; the bundled `code-review` skill, which reports through `ReportFindings`"), mako: makoLacks("Mako draws a review's calls in the transcript; starting one from Mako isn't built.") },
    sideQuestions: { native: native("/btw", "`/btw`, answered without interrupting the main conversation"), mako: makoLacks("Mako doesn't ask side questions yet.") },
    scheduledPrompts: { native: native("/loop", "`/loop [interval] <prompt>` through `CronCreate`, `CronDelete` and `CronList`, or `ScheduleWakeup` when it paces itself"), mako: makoLacks("Mako draws the calls that set one up but doesn't track schedules, so closing an idle conversation's process can end them.") },
    cloudRuns: { native: native("--cloud, /schedule", "`--cloud` and `--remote` sessions; `/schedule` (`/routines`) and `RemoteTrigger` for remote agents"), mako: makoLacks("Mako runs Claude Code on this Mac; handing a conversation to its cloud isn't built.") },
    backgroundSessions: { native: native("claude --bg", "`claude --bg` and `/background`, listed by `claude agents`"), mako: makosOwn("It doesn't attach to sessions started with `claude --bg`.") },
    fileRewind: { native: native("/rewind", "`/rewind` (`/checkpoint`, `/undo`); the SDK's `enableFileCheckpointing` and `rewindFiles`"), mako: makosOwn("Claude Code's own checkpoints aren't used.") },
    worktrees: { native: native("--worktree", "`--worktree`, the `EnterWorktree` and `ExitWorktree` tools, and agents started with `isolation: \"worktree\"`"), mako: makosOwn() },
    computerUse: { native: native("computer use", "its `computer-use` MCP server and Claude in Chrome, in its own terminal only"), mako: makosOwn() },
    notifications: { native: native("PushNotification", "the `PushNotification` tool, with `agentPushNotifEnabled`"), mako: makosOwn() },
    folderTrust: { native: native("trust dialog", "the first-run trust dialog, kept per project as `hasTrustDialogAccepted`"), mako: makoLacks("Mako doesn't read or set whether Claude Code trusts the folder.") },
    editApprovals: { native: native("updatedInput", "a `canUseTool` answer can carry `updatedInput`"), mako: makoLacks("The approval card runs the input Claude Code proposed; editing it first isn't built.") },
    plugins: { native: native("plugins", "`.claude-plugin/plugin.json`, marketplaces, `/plugin`"), mako: byDefault("Claude Code loads the plugins its settings enable in sessions Mako starts.") },
    responseStyle: { native: native("output styles", "`outputStyle`, and `output-styles` folders in `~/.claude` and the project"), mako: byDefault("Claude Code applies the output style its settings name in sessions Mako starts.") },
    webSearch: { mako: TOOL_ROWS },
    imageGeneration: { mako: harnessLacks("Claude Code has no image generation tool.") },
    codeMode: { mako: harnessLacks("Claude Code has no code mode; each tool is its own call.") },
  },
  unique: [],
  hooks: createClaudeHooks(),
  commands: createClaudeCommands(),
  toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
  skillEditing: { provider: "claude", route: "skill-registry", operations: ["import", "remove"] },
  mcpEditing: { provider: "claude", route: "mcp-registry", operations: ["import"] },
  live: createClaudeLiveDriver(context),
  decoder: claudeDecoderSource,
  profile: createClaudeProfileLoader(host.discovery),
  accounts: claudeAccountCapability,
  acp: lacks("Runs on the Claude Agent SDK"),
  nativeRunner: claudeNativeRunner,
  processProbe: claudeProcessProbe,
  mcp: claudeMcpSource,
  skills: claudeSkillSource,
  sessionEmitter: {
    provider: "claude",
    emit: async (thread) => emitClaudeSession(context.stores, thread, { store: (await host.accounts.env("claude", process.env)).CLAUDE_CONFIG_DIR || undefined }),
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
  usageHistory: claudeUsageHistory,
  artifactPreview: lacks("It writes no artifact files of its own; the file viewer previews what it writes by file type."),
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

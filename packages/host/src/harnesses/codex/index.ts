import { createCodexLiveDriver } from "./live-driver.js"
import { installHarness, lacks } from "../harness-definition.js"
import { createCodexHooks, createCodexMcpEditing } from "./authoring.js"
import type { ProviderModule } from "../host.js"
import { byDefault, harnessLacks, implemented, makoLacks } from "../live-capabilities.js"
import { makosOwn, native, shownAs, TOOL_ROWS } from "../../contracts/harness-features.js"
import { codexAccountCapability } from "./accounts.js"
import { codexDecoderSource } from "./decoder-source.js"
import { codexMcpSource } from "./mcp.js"
import { codexNativeRunner } from "./native-runner.js"
import { createCodexProcessProbe } from "./process-probe.js"
import { codexProfileLoader } from "./profile.js"
import { codexSkillSource } from "./skills.js"
import { codexStartFiles, resolveCodexExecutable } from "./executable.js"
import { npmInstall } from "../update-source.js"
import { CODEX_VERSIONS } from "./versions.js"
import { codexUsageHistory } from "./usage-history.js"
import { codexPresentation } from "./presentation.js"

export const installCodex: ProviderModule = (host, context) => {
  const probe = createCodexProcessProbe()
  installHarness(host, {
    provider: "codex",
    presentation: codexPresentation,
    diagnostics: {},
    usage: {
      context: implemented("Codex's own reading in `thread/tokenUsage/updated`."),
      window: implemented("The model's window in the same reading."),
      compaction: implemented("Codex sends a new reading after compacting, before the compaction item completes."),
      tokens: implemented("The reading's thread total, less what it said before."),
      cost: harnessLacks("Codex reports tokens only and prices none of them."),
      missedCalls: harnessLacks("Codex's readings never say they left a call out."),
      resetCredits: implemented("ChatGPT's usage report lists the plan's reset credits, and the account's row spends one."),
      balance: implemented("ChatGPT credits left, in the usage report."),
      limitSwitch: implemented("Each account's 5-hour and weekly windows from `account/rateLimits/read`, amended live by `account/rateLimits/updated`, and a refused turn's usage-limit error."),
      toolSpend: harnessLacks("Codex reports tokens per turn and per request, and a request reads every tool result before it; its tool items carry no tokens."),
    },
    features: {
      goals: { native: native("/goal", "`thread/goal/set`, `get` and `clear` with `thread/goal/updated`; the `create_goal`, `get_goal` and `update_goal` tools; it starts the next turn itself while the goal is active"), mako: shownAs("`/goal` and the goal bar set, pause, resume and clear it through `thread/goal/*`; Codex runs each turn toward it. A `--budget` goes as the goal's `tokenBudget`, and Codex stops at it.") },
      review: { native: native("/review", "`review/start` on uncommitted changes, a base branch, a commit or custom instructions; `enteredReviewMode` and `exitedReviewMode` items"), mako: shownAs("`/review` opens the review picker above the composer and starts Codex's review of the target through `review/start`. Its findings show as the review's card, in place of the reply that repeats them.") },
      sideQuestions: { native: native("/side, /btw", "`/side` and `/btw` in its terminal"), mako: shownAs("`/btw` or `/side` opens the side panel above the composer, and Codex answers on an ephemeral fork of the thread, as its `/side` does, with a read-only sandbox.") },
      scheduledPrompts: { mako: harnessLacks("Codex has no schedule; its `sleep` tool only waits inside a turn.") },
      cloudRuns: { native: native("codex cloud", "`codex cloud` tasks, started from its CLI"), mako: makoLacks("Starting a Codex cloud task from Mako isn't built.") },
      backgroundSessions: { mako: makosOwn() },
      fileRewind: { native: native("thread/revert", "`thread/revert`, which takes back turns but not files; its file undo is removed"), mako: makosOwn() },
      worktrees: { native: native("/worktree", "`/worktree` and `--worktree` in its terminal"), mako: makosOwn() },
      computerUse: { native: native("computer use", "the `computer_use` feature's bundled `computer-use` MCP server"), mako: makosOwn() },
      notifications: { native: native("notify", "the `notify` command in its config, run when a turn ends"), mako: makosOwn() },
      folderTrust: { native: native("trust_level", "`projects.<path>.trust_level` in its config"), mako: makoLacks("Mako doesn't read or set the folder's trust level.") },
      editApprovals: { mako: harnessLacks("Codex's approvals accept, decline or add a rule; none changes the command.") },
      plugins: { native: native("plugins", "`plugin/list`, `plugin/install` and marketplaces; `/plugins`"), mako: byDefault("Codex loads its installed plugins in sessions Mako starts; Mako doesn't list or install them.") },
      responseStyle: { native: native("personality", "`personality` on `thread/start` and `turn/start`"), mako: harnessLacks("Codex still takes a personality but no longer applies a style for it.") },
      webSearch: { mako: TOOL_ROWS },
      imageGeneration: { native: native("image generation", "the `image_generation` feature's `imageGeneration` items"), mako: shownAs("The image, in the transcript.") },
      codeMode: { mako: TOOL_ROWS },
    },
    unique: [],
    hooks: createCodexHooks(),
    commands: lacks("Codex 0.159 reads no prompt files: ~/.codex/prompts is retired, and its commands are skills, under Skills"),
    toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
    skillEditing: { provider: "codex", route: "skill-registry", operations: ["import", "remove"] },
    mcpEditing: createCodexMcpEditing(),
    live: createCodexLiveDriver(probe, context),
    decoder: codexDecoderSource,
    profile: codexProfileLoader(host.discovery),
    accounts: codexAccountCapability(host.discovery),
    acp: lacks("Runs on Codex’s app-server"),
    nativeRunner: codexNativeRunner,
    processProbe: probe,
    mcp: codexMcpSource,
    skills: codexSkillSource,
    connection: lacks("Signs in through `codex login`"),
    // No self-updater: the npm CLI upgrades through npm or Homebrew, the
    // bundled one arrives with ChatGPT.app, and `codex` on PATH could be either.
    updates: {
      provider: "codex",
      binary: (env) => resolveCodexExecutable(env),
      startFiles: codexStartFiles,
      npmPackage: "@openai/codex",
      homebrew: { name: "codex" },
      versions: CODEX_VERSIONS,
      install: [
        npmInstall("@openai/codex", CODEX_VERSIONS.tested),
        { label: "Install with Homebrew", command: "brew", args: ["install", "codex"] },
      ],
    },
    usageHistory: codexUsageHistory,  artifactPreview: lacks("It writes no artifact files of its own; the file viewer previews what it writes by file type."),
  })
}

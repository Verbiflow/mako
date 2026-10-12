import { createAcpLiveDriver } from "../acp-live-driver.js"
import { acpDecoderSource } from "../acp-decoder-source.js"
import { emitGrokSession } from "@mako/sessions"
import { installHarness, lacks, notBuilt } from "../harness-definition.js"
import type { ProviderModule } from "../host.js"
import { byDefault, harnessLacks, implemented, makoLacks, noOp } from "../live-capabilities.js"
import { makosOwn, native, shownAs, shownInTools, TOOL_ROWS } from "../../contracts/harness-features.js"
import { createGrokAcpSource } from "./acp.js"
import { grokMcpSource } from "./mcp.js"
import { grokNativeRunner } from "./native-runner.js"
import { grokProcessProbe } from "./process-probe.js"
import { grokProfileLoader } from "./profile.js"
import { grokSkillSource } from "./skills.js"
import { createGrokConnection } from "./connection.js"
import { grokAccountCapability } from "./accounts.js"
import { npmInstall, scriptInstall } from "../update-source.js"
import { grokUsageHistory } from "./usage-history.js"
import {
  environmentForExecutable,
  resolveExecutable,
} from "../../base/executable.js"
import { grokPresentation } from "./presentation.js"

export const installGrok: ProviderModule = (host, context) => {
  const acp = createGrokAcpSource()
  const profile = grokProfileLoader(host.discovery)
  installHarness(host, {
    provider: "grok",
    presentation: grokPresentation,
    diagnostics: { sdk: "@agentclientprotocol/sdk" },
    usage: {
      context: implemented("The main agent's last call, from each `response_completed`."),
      window: implemented("The current model's `totalContextTokens`, in the reply that opens the session and in Grok's model-list updates."),
      compaction: implemented("`auto_compact_completed`'s `tokens_after`."),
      tokens: implemented("Each `turn_completed`'s usage."),
      cost: implemented("Each `turn_completed`'s `costUsdTicks`."),
      missedCalls: implemented("`usageIsIncomplete` on a turn's usage."),
      resetCredits: harnessLacks("Grok's usage report has no reset credits."),
      balance: makoLacks("Grok's billing gives on-demand and prepaid amounts with no unit, so Mako doesn't show them until one is confirmed."),
    },
    features: {
      goals: { native: native("/goal", "`/goal <objective>` with `status`, `pause`, `resume` and `clear`, when goal mode is on; the `update_goal` tool; `goal_updated` updates"), mako: shownAs("`/goal` and the goal bar send Grok's `/goal` commands, and the bar shows its `goal_updated` reports.") },
      review: { mako: harnessLacks("Grok has no review command; a skill can add one.") },
      sideQuestions: { native: native("/btw", "`/btw`, answered in a panel beside the turn"), mako: makoLacks("Mako doesn't ask side questions yet.") },
      scheduledPrompts: { native: native("/loop", "`/loop [interval] <prompt>`; the `scheduler_create`, `scheduler_delete` and `scheduler_list` tools; `_x.ai/scheduled_task_*`"), mako: makoLacks("Mako draws the calls that set one up but doesn't track schedules, so closing an idle conversation's process can end them.") },
      cloudRuns: { mako: harnessLacks("Grok runs only on this Mac.") },
      backgroundSessions: { mako: makosOwn() },
      fileRewind: { native: native("/rewind", "`/rewind` (`/undo`), which takes back turns but not files"), mako: makosOwn() },
      worktrees: { native: native("-w", "`-w` and `cli.worktree_type`"), mako: makosOwn() },
      computerUse: { mako: makosOwn() },
      notifications: { mako: makosOwn() },
      folderTrust: { native: native("folder trust", "`_x.ai/folder_trust/request` to a client that sets `x.ai/folderTrust.interactive`, saved in `~/.grok/trusted_folders.toml`"), mako: shownAs("A card asking whether to trust the folder.") },
      editApprovals: { mako: harnessLacks("Grok's approvals allow or reject; only a plan refusal carries words.") },
      plugins: { native: native("plugins", "`/plugins` and `/marketplace`"), mako: byDefault("Grok loads its installed plugins in sessions Mako starts.") },
      responseStyle: { native: native("/personas", "personas, which shape a subagent it starts"), mako: harnessLacks("Grok's personas shape its subagents, not its own replies.") },
      webSearch: { mako: TOOL_ROWS },
      imageGeneration: { native: native("image_gen, image_edit", "the `image_gen` and `image_edit` tools; `/imagine`"), mako: shownAs("Its tool rows in the transcript.") },
      codeMode: { mako: harnessLacks("Grok has no code mode; each tool is its own call.") },
    },
    unique: [
      { name: "X search", native: "`x_search`, a server-side xAI search of X, reported by its title", mako: shownInTools(["x_search"]) },
      { name: "Video generation", native: "the `image_to_video` and `reference_to_video` tools; `/imagine-video`", mako: shownInTools(["image_to_video", "reference_to_video"]) },
      { name: "Announcements", native: "`_x.ai/announcements/update`", mako: noOp("They're xAI's product news for Grok's own pager, so Mako ignores them.") },
    ],
    hooks: notBuilt("Hook discovery and editing have not been verified in Mako"),
    commands: notBuilt("Custom command authoring is not implemented; live command discovery remains available"),
    toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
    skillEditing: { provider: "grok", route: "skill-registry", operations: ["import", "remove"] },
    mcpEditing: { provider: "grok", route: "mcp-registry", operations: ["import"] },
    live: createAcpLiveDriver(acp, host, context),
    decoder: acpDecoderSource(acp),
    profile,
    accounts: grokAccountCapability(host.discovery),
    acp,
    nativeRunner: grokNativeRunner,
    processProbe: grokProcessProbe,
    mcp: grokMcpSource,
    skills: grokSkillSource,
    sessionEmitter: {
      provider: "grok",
      emit: (thread) => emitGrokSession(context.stores, thread, {}),
    },
    connection: createGrokConnection(host.discovery, profile),
    // The install script keeps versioned binaries under ~/.grok/bin and links
    // `grok` at the current one; the npm package is the other install.
    updates: {
      provider: "grok",
      binary: (env) => resolveExecutable("grok", env),
      npmPackage: "@xai-official/grok",
      updateEnvironment: grokUpdateEnvironment,
      native: {
        label: "Update Grok",
        args: ["update"],
        ownsPath: (path) => path.includes("/.grok/bin/"),
      },
      install: [
        scriptInstall("https://x.ai/cli/install.sh"),
        npmInstall("@xai-official/grok"),
      ],
    },
    usageHistory: grokUsageHistory,  artifactPreview: lacks("It writes no artifact files of its own; the file viewer previews what it writes by file type."),
  })
}

/** Grok's own updater can spawn npm even when its binary lives in ~/.grok/bin.
 * Upstream: xai-grok-update/src/auto_update.rs, get_installer and install_npm.
 */
export function grokUpdateEnvironment(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const npm = resolveExecutable("npm", env)
  const prepared = npm ? environmentForExecutable(npm, env) : env
  // npm 12 otherwise skips the postinstall that replaces ~/.grok/bin/grok.
  return { ...prepared, npm_config_allow_scripts: "@xai-official/grok" }
}

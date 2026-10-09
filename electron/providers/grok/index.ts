import { acpLiveDriver } from "../acp-live-driver.js"
import { acpDecoderSource } from "../acp-decoder-source.js"
import { emitGrokSession } from "@mako/sessions"
import { installHarness, lacks, notBuilt } from "../harness-definition.js"
import type { ProviderModule } from "../host.js"
import { harnessLacks, implemented, noOp } from "../live-capabilities.js"
import { shownBy, shownInTools } from "../../contracts/harness-unique.js"
import { grokAcpSource } from "./acp.js"
import { grokMcpSource } from "./mcp.js"
import { grokNativeRunner } from "./native-runner.js"
import { grokProcessProbe } from "./process-probe.js"
import { grokProfileLoader } from "./profile.js"
import { grokSkillSource } from "./skills.js"
import { grokConnection } from "./connection.js"
import { grokAccountCapability } from "./accounts.js"
import { npmInstall, scriptInstall } from "../update-source.js"
import { grokUsageHistory } from "./usage-history.js"
import {
  environmentForExecutable,
  resolveExecutable,
} from "../../executable.js"
import { grokPresentation } from "./presentation.js"

export const installGrok: ProviderModule = (host) => installHarness(host, {
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
  },
  unique: [
    { name: "X search", native: "`x_search`, a server-side xAI search reported by its title", mako: shownInTools(["x_search"]) },
    { name: "Image and video generation", native: "`image_gen`, `image_edit`, `image_to_video` and `reference_to_video` tools; `/imagine`, `/imagine-video`", mako: shownInTools(["image_gen", "image_edit", "image_to_video", "reference_to_video"]) },
    { name: "Incomplete usage reports", native: "`usageIsIncomplete` and `costIsPartial` on a turn's usage", mako: shownBy("usage.missedCalls") },
    { name: "Announcements", native: "`_x.ai/announcements/update`", mako: noOp("They're xAI's product news for Grok's own pager, so Mako ignores them.") },
    { name: "Folder trust", native: "`_x.ai/folder_trust/request` to a client that sets `x.ai/folderTrust.interactive`, saved in `~/.grok/trusted_folders.toml`", mako: shownBy("capabilities.approvals") },
  ],
  hooks: notBuilt("Hook discovery and editing have not been verified in Mako"),
  commands: notBuilt("Custom command authoring is not implemented; live command discovery remains available"),
  toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
  skillEditing: { provider: "grok", route: "skill-registry", operations: ["import", "remove"] },
  mcpEditing: { provider: "grok", route: "mcp-registry", operations: ["import"] },
  live: acpLiveDriver(grokAcpSource),
  decoder: acpDecoderSource(grokAcpSource),
  profile: grokProfileLoader,
  accounts: grokAccountCapability,
  acp: grokAcpSource,
  nativeRunner: grokNativeRunner,
  processProbe: grokProcessProbe,
  mcp: grokMcpSource,
  skills: grokSkillSource,
  sessionEmitter: {
    provider: "grok",
    emit: (thread) => emitGrokSession(thread, {}),
  },
  connection: grokConnection(),
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

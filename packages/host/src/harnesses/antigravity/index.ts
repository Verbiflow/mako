import { antigravityMcp, antigravityMcpEditing } from "./mcp.js"
import { antigravityProbe } from "./resume.js"
import { onWindows } from "../../base/platform.js"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveExecutable } from "../../base/executable.js"
import { makosOwn, TOOL_ROWS } from "../../contracts/harness-features.js"
import { createAcpLiveDriver } from "../acp-live-driver.js"
import { acpDecoderSource } from "../acp-decoder-source.js"
import { installHarness, lacks, notBuilt } from "../harness-definition.js"
import { byDefault, harnessLacks, implemented, makoLacks } from "../live-capabilities.js"
import type { ProviderModule } from "../host.js"
import { antigravityInstall, antigravityTarget } from "./install.js"
import { version as built } from "./builds.js"
import { antigravityAccounts } from "./accounts.js"
import { antigravityAcp as acp } from "./acp.js"
import { antigravityProfile } from "./profile.js"
import { antigravityUsageHistory } from "./usage-history.js"

const skillRoot = (folder: string) => join(process.env.GEMINI_HOME || join(homedir(), ".gemini"), folder, "skills")
export const installAntigravity: ProviderModule = (host, context) => {
  const install = antigravityInstall()
  return installHarness(host, {
    provider: acp.provider,
    presentation: { mark: {
      viewBox: "0 0 24 24", tint: "#4285F4",
      paths: [{ d: "M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z" }],
    } },
    diagnostics: { sdk: "@agentclientprotocol/sdk" },
    usage: {
      context: implemented("The used tokens in an ACP usage update."),
      window: implemented("The context size in the same update."),
      compaction: makoLacks("Mako does not measure the context after /compact."),
      tokens: implemented("Token usage on the ACP prompt response."),
      cost: harnessLacks("Antigravity reports token counts without a billed amount."),
      missedCalls: makoLacks("Mako has no count of unreported calls."),
      resetCredits: makoLacks("Mako does not read Google reset credits."),
      balance: makoLacks("Mako does not read the Google billing balance."),
      limitSwitch: makoLacks("Mako does not read account limit windows."),
      toolSpend: makoLacks("Mako does not attribute model tokens to individual tools."),
    },
    features: {
      goals: { mako: makosOwn() }, review: { mako: makosOwn() },
      sideQuestions: { mako: makoLacks("Mako does not open a separate Antigravity session for side questions.") },
      scheduledPrompts: { mako: makoLacks("Mako does not schedule Antigravity prompts.") },
      cloudRuns: { mako: makoLacks("This integration launches the local ACP agent.") },
      backgroundSessions: { mako: makosOwn() }, fileRewind: { mako: makosOwn() },
      worktrees: { mako: makosOwn() }, computerUse: { mako: makosOwn() }, notifications: { mako: makosOwn() },
      folderTrust: { mako: byDefault("The CLI applies its workspace configuration.") },
      editApprovals: { mako: makoLacks("The client returns an option from the agent's permission request.") },
      plugins: { mako: byDefault("Antigravity loads installed plugins.") },
      responseStyle: { mako: makoLacks("Mako does not set a response style.") },
      webSearch: { mako: TOOL_ROWS },
      imageGeneration: { mako: byDefault("The agent can report image generation as ACP tool calls.") },
      codeMode: { mako: makoLacks("Mako does not decode a separate code mode.") },
    },
    unique: [],
    acp, live: createAcpLiveDriver(acp, host, context), decoder: acpDecoderSource(acp),
    profile: antigravityProfile(host.discovery, context.dataRoot), accounts: antigravityAccounts(host.accounts.root, context.secrets.secrets),
    skills: { provider: acp.provider, command: () => resolveExecutable("agy"), userRoots: () => [skillRoot("config"), skillRoot("antigravity-cli")],
      workspaceFolder: ".gemini", targetUserRoot: () => skillRoot("config"), readsUniversalRoot: false },
    skillEditing: { provider: acp.provider, route: "skill-registry", operations: ["import", "remove"] },
    hooks: notBuilt("Mako does not edit Antigravity hooks."),
    commands: notBuilt("Antigravity supplies commands to the running session."),
    toolEditing: lacks("The runtime supplies native tools."),
    mcp: antigravityMcp,
    mcpEditing: antigravityMcpEditing,
    nativeRunner: notBuilt("Unattended work uses the ACP driver."),
    processProbe: antigravityProbe,
    usageHistory: antigravityUsageHistory(context.stores),
    artifactPreview: notBuilt("Mako does not collect the agent's brain directory."),
    connection: lacks("Sign-in uses the agent's own ACP authentication."),
    updates: { provider: acp.provider, binary: (env) => resolveExecutable("agy", env),
      // Tested is the build `builds` holds the files and digests of: the install and Update put exactly it in place.
      versions: { tested: built, oldest: "1.5.15", feed: { manifest: `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${antigravityTarget() ?? "darwin_arm64"}.json` },
        checked: { on: "2026-11-23", how: "ACP handshake, model discovery, HTTP MCP and a complete Gemini-compatible test turn with agy 1.5.15." } },
      install: install ? [install] : [],
      // Its own updater is the CLI itself, so Update is the verified install at `tested`, never the bare `agy`.
      native: install && { label: "Update Antigravity", installVersion: antigravityInstall, ownsPath: (path, env) => path === join(env?.HOME || env?.USERPROFILE || homedir(), ".local", "bin", onWindows() ? "agy.exe" : "agy") },
    },
  })
}

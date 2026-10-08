import { homedir } from "node:os"
import { join } from "node:path"
import { codexLiveDriver } from "./live-driver.js"
import { emitCodexSession } from "@mako/sessions"
import { codexModelProvider } from "./credentials.js"
import { installHarness, lacks, notBuilt } from "../harness-definition.js"
import type { ProviderModule } from "../host.js"
import { harnessLacks, implemented } from "../live-capabilities.js"
import { codexAccountCapability } from "./accounts.js"
import { codexDecoderSource } from "./decoder-source.js"
import { codexMcpSource } from "./mcp.js"
import { codexNativeRunner } from "./native-runner.js"
import { codexProcessProbe } from "./process-probe.js"
import { codexProfileLoader } from "./profile.js"
import { codexSkillSource } from "./skills.js"
import { resolveCodexExecutable } from "./executable.js"
import { npmInstall } from "../update-source.js"
import { codexUsageHistory } from "./usage-history.js"
import { codexPresentation } from "./presentation.js"

export const installCodex: ProviderModule = (host) => installHarness(host, {
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
  },
  hooks: notBuilt("Hook discovery and editing have not been verified in Mako"),
  commands: notBuilt("Custom command authoring is not implemented; live command discovery remains available"),
  toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
  skillEditing: { provider: "codex", route: "skill-registry", operations: ["import", "remove"] },
  mcpEditing: { provider: "codex", route: "mcp-registry", operations: ["import"] },
  live: codexLiveDriver,
  decoder: codexDecoderSource,
  profile: codexProfileLoader,
  accounts: codexAccountCapability,
  acp: lacks("Runs on Codex’s app-server"),
  nativeRunner: codexNativeRunner,
  processProbe: codexProcessProbe,
  mcp: codexMcpSource,
  skills: codexSkillSource,
  sessionEmitter: {
    provider: "codex",
    // Loaded on use: `accounts` reaches the provider registry this module is part of.
    emit: async (thread) => {
      const { accountEnv } = await import("../../accounts.js")
      const store = (await accountEnv("codex", process.env)).CODEX_HOME || undefined
      return emitCodexSession(thread, { store, codexModelProvider: await codexModelProvider(store ?? join(homedir(), ".codex")) })
    },
  },
  connection: lacks("Signs in through `codex login`"),
  // No self-updater: the npm CLI upgrades through npm or Homebrew, the
  // bundled one arrives with ChatGPT.app, and `codex` on PATH could be either.
  updates: {
    provider: "codex",
    binary: (env) => resolveCodexExecutable(env),
    npmPackage: "@openai/codex",
    homebrew: { name: "codex" },
    install: [
      npmInstall("@openai/codex"),
      { label: "Install with Homebrew", command: "brew", args: ["install", "codex"] },
    ],
  },
  usageHistory: codexUsageHistory,  artifactPreview: lacks("Writes no artifact Mako previews"),
})

import { codexLiveDriver } from "./live-driver.js"
import { emitCodexSession } from "@mako/sessions"
import { installHarness, lacks } from "../harness-definition.js"
import type { ProviderModule } from "../host.js"
import { codexAccountCapability } from "./accounts.js"
import { codexDecoderSource } from "./decoder-source.js"
import { codexMcpSource } from "./mcp.js"
import { codexNativeRunner } from "./native-runner.js"
import { codexProcessProbe } from "./process-probe.js"
import { codexProfileLoader } from "./profile.js"
import { codexSkillSource } from "./skills.js"
import { resolveCodexExecutable } from "./executable.js"
import { npmInstall } from "../update-source.js"

export const installCodex: ProviderModule = (host) => installHarness(host, {
  provider: "codex",
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
      return emitCodexSession(thread, { store: (await accountEnv("codex", process.env)).CODEX_HOME || undefined })
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
  artifactPreview: lacks("Writes no artifact Mako previews"),
})

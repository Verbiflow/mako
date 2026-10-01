import { acpLiveDriver } from "../acp-live-driver.js"
import { acpDecoderSource } from "../acp-decoder-source.js"
import { emitGrokSession } from "@mako/sessions"
import { installHarness, lacks } from "../harness-definition.js"
import type { ProviderModule } from "../host.js"
import { grokAcpSource } from "./acp.js"
import { grokMcpSource } from "./mcp.js"
import { grokNativeRunner } from "./native-runner.js"
import { grokProcessProbe } from "./process-probe.js"
import { grokProfileLoader } from "./profile.js"
import { grokSkillSource } from "./skills.js"
import { grokConnection } from "./connection.js"
import { grokAccountCapability } from "./accounts.js"
import { npmInstall, scriptInstall } from "../update-source.js"
import {
  environmentForExecutable,
  resolveExecutable,
} from "../../executable.js"

export const installGrok: ProviderModule = (host) => installHarness(host, {
  provider: "grok",
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
  artifactPreview: lacks("Writes no artifact Mako previews"),
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

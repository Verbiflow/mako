import { acpLiveDriver } from "../acp-live-driver.js"
import { emitGrokSession } from "@mako/sessions"
import type { ProviderModule } from "../host.js"
import { grokAcpSource } from "./acp.js"
import { grokMcpSource } from "./mcp.js"
import { grokNativeRunner } from "./native-runner.js"
import { grokProcessProbe } from "./process-probe.js"
import { grokProfileLoader } from "./profile.js"
import { grokSkillSource } from "./skills.js"
import { grokConnection } from "./connection.js"
import {
  environmentForExecutable,
  resolveExecutable,
} from "../../executable.js"

export const installGrok: ProviderModule = (host) => {
  host.connections.register(grokConnection())
  host.nativeRunners.register(grokNativeRunner)
  host.acpSources.register(grokAcpSource)
  host.liveDrivers.register(acpLiveDriver(grokAcpSource))
  host.profiles.register(grokProfileLoader)
  host.processProbes.register(grokProcessProbe)
  host.mcpSources.register(grokMcpSource)
  host.skillSources.register(grokSkillSource)
  host.sessionEmitters.register({
    provider: "grok",
    emit: (thread) => emitGrokSession(thread, {}),
  })
  // The install script keeps versioned binaries under ~/.grok/bin and links
  // `grok` at the current one; the npm package is the other install.
  host.updateSources.register({
    provider: "grok",
    binary: (env) => resolveExecutable("grok", env),
    npmPackage: "@xai-official/grok",
    updateEnvironment: grokUpdateEnvironment,
    native: {
      label: "Update Grok",
      args: ["update"],
      ownsPath: (path) => path.includes("/.grok/bin/"),
    },
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

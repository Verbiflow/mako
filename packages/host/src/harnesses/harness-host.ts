import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { installedAppRoot } from "../base/host-environment.js"
import { MachineAbsentError } from "../base/machine.js"
import { detachedSecrets } from "../base/host-secrets.js"
import { installClaude } from "./claude/index.js"
import { installCodex } from "./codex/index.js"
import { installCursor } from "./cursor/index.js"
import { installDevin } from "./devin/index.js"
import { installGrok } from "./grok/index.js"
import { createProviderHost, type HarnessContext, type ProviderHost, type ProviderModule } from "./host.js"
import { installOpenCode } from "./opencode/index.js"

/**
 * Every harness, in Mako's order: the order it tries them in when it must
 * pick one itself, such as setting a project up or drafting a commit
 * message, until the person reorders them in Settings › Models.
 */
const modules: ProviderModule[] = [
  installClaude,
  installCodex,
  installCursor,
  installOpenCode,
  installGrok,
  installDevin,
]

/** A provider host with every harness Mako ships installed on it. */
export function createHarnessHost(context: HarnessContext): ProviderHost {
  const host = createProviderHost()
  for (const install of modules) install(host, context)
  return host
}

/**
 * A context that reaches nothing of the person's: secrets held in memory, no
 * screen, and files under `dataRoot`, a temporary folder unless one is given.
 * For a worker, a script or a test.
 */
export function detachedHarnessContext(dataRoot = join(tmpdir(), "mako-detached-harnesses")): HarnessContext {
  return {
    dataRoot,
    appRoot: installedAppRoot(dirname(fileURLToPath(import.meta.url))),
    secrets: detachedSecrets(),
    openUrl: async () => {
      throw new MachineAbsentError("A detached harness host opens nothing on this machine.")
    },
  }
}

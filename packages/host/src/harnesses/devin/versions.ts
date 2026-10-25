import type { HarnessUpdateCommand } from "../../contracts/harness-updates.js"
import type { HarnessVersions } from "../../contracts/harness-versions.js"
import { scriptInstall } from "../update-source.js"

/**
 * The Devin CLIs Mako runs. A standalone install goes to `tested` through
 * Devin's versioned setup script (`static.devin.ai/cli/<version>/setup.sh`,
 * which answered for 3000.10.23 on October 12 and 3000.11.205 on October
 * 25); the copies in Devin.app and Zed update with those apps. No oldest:
 * Devin's pairs run on its own model, which spends usage, so only the build
 * being tested is recorded (3000.10.23, then 3000.11.205). Where Devin's
 * ACP handshake advertises a capability, that answers instead of a version.
 */
export const DEVIN_VERSIONS: HarnessVersions = {
  tested: "3000.11.205",
  feed: { manifest: "https://static.devin.ai/cli/current/manifest.json" },
  checked: {
    on: "2026-10-25",
    how: "the version every record names: the vocabulary, native-tools/devin-3000.11.205.json, the decode pairs and devin-concepts.json",
  },
}

/** Devin's setup script for one version; the build system pins `PINNED_VERSION` in each. */
export function devinSetup(version: string): HarnessUpdateCommand {
  return scriptInstall(`https://static.devin.ai/cli/${version}/setup.sh`)
}

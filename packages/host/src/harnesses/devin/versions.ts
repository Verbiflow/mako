import type { HarnessUpdateCommand } from "../../contracts/harness-updates.js"
import type { HarnessVersions } from "../../contracts/harness-versions.js"
import { scriptInstall } from "../update-source.js"

/**
 * The Devin CLIs Mako runs. A standalone install goes to `tested` through
 * Devin's versioned setup script (`static.devin.ai/cli/<version>/setup.sh`,
 * which answered for 3000.10.23 on October 12); the copies in Devin.app and
 * Zed update with those apps. No oldest: only 3000.10.23 has been recorded,
 * and Devin's pairs run on its own model, which spends usage. Where Devin's
 * ACP handshake advertises a capability, that answers instead of a version.
 */
export const DEVIN_VERSIONS: HarnessVersions = {
  tested: "3000.10.23",
  feed: { manifest: "https://static.devin.ai/cli/current/manifest.json" },
  checked: {
    on: "2026-10-12",
    how: "the version every record names: the vocabulary, native-tools/devin-3000.10.23.json, the decoder fixtures and devin-concepts.json",
  },
}

/** Devin's setup script for one version; the build system pins `PINNED_VERSION` in each. */
export function devinSetup(version: string): HarnessUpdateCommand {
  return scriptInstall(`https://static.devin.ai/cli/${version}/setup.sh`)
}

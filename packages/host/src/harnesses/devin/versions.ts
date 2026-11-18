import type { HarnessUpdateCommand } from "../../contracts/harness-updates.js"
import type { HarnessVersions } from "../../contracts/harness-versions.js"
import { scriptInstall } from "../update-source.js"

/**
 * The Devin CLIs Mako runs. A standalone install goes to `tested` through
 * Devin's versioned setup script (`static.devin.ai/cli/<version>/setup.sh`,
 * which answered for 3000.10.23 on October 12, 3000.11.205 on October 25,
 * 3000.11.234 on October 30, 3000.12.28 on November 7, 3000.12.43 on November 11, 3000.12.57 on November 16 (gone the next day) and 3000.13.4 on November 17; 3000.12.17 answered that morning
 * and was withdrawn by evening, as was 3000.12.20); the copies in Devin.app and Zed update
 * with those apps. No oldest: Devin's pairs ran on its own model, which
 * spent usage, until they were sealed against a stand-in for its API server
 * (`scripts/scripted-windsurf.ts`), so only the builds tested were recorded
 * (3000.10.23, 3000.11.205, 3000.11.234, 3000.12.28, 3000.12.43, 3000.12.57, then 3000.13.4).
 * Where Devin's ACP handshake advertises a capability, that answers instead
 * of a version.
 */
export const DEVIN_VERSIONS: HarnessVersions = {
  tested: "3000.14.30821",
  feed: { manifest: "https://static.devin.ai/cli/current/manifest.json" },
  checked: {
    on: "2026-11-18",
    how: "the version every record names: the vocabulary, native-tools/devin-3000.13.4.json, the decode pairs and devin-concepts.json",
  },
  // Its setup script's layout: the build under `_versions`, `current` and `~/.local/bin/devin` linked to it, and the
  // marker its updater reads for where it came from.
  kept: {
    targets: ["x86_64-unknown-linux", "aarch64-unknown-linux"],
    unpack: ".local/share/devin/cli/_versions/{version}",
    links: {
      ".local/share/devin/cli/_versions/current": "{version}",
      ".local/bin/devin": "~/.local/share/devin/cli/_versions/current/bin/devin",
    },
    files: { ".local/share/devin/cli/_versions/{version}/distribution": "curl-bash\n" },
  },
}

/** Devin's setup script for one version; the build system pins `PINNED_VERSION` in each. */
export function devinSetup(version: string): HarnessUpdateCommand {
  return scriptInstall(`https://static.devin.ai/cli/${version}/setup.sh`)
}

/** Devin's unversioned setup script, which installs its newest build (`PINNED_VERSION` empty). */
export function devinNewest(): HarnessUpdateCommand {
  return scriptInstall("https://static.devin.ai/cli/setup.sh")
}

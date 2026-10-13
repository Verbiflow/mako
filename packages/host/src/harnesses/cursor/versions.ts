import type { HarnessVersions } from "../../contracts/harness-versions.js"

/**
 * Cursor sessions run its SDK inside Mako, so `tested` is the SDK in Mako's
 * lockfile and nothing is pinned: `cursor-agent` is only the CLI Settings
 * updates, on Cursor's own updates.
 */
export const CURSOR_VERSIONS: HarnessVersions = {
  tested: "1.0.31",
  bundled: { package: "@cursor/sdk", version: "1.0.31" },
  feed: { npm: "@cursor/sdk" },
  checked: {
    on: "2026-10-12",
    how: "@cursor/sdk 1.0.31 in Mako's lockfile, which the vocabulary, native-tools/cursor-1.0.31.json, the decoder fixtures and cursor-concepts.json name",
  },
}

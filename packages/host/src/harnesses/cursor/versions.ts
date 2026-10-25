import type { HarnessVersions } from "../../contracts/harness-versions.js"

/**
 * Cursor sessions run its SDK inside Mako, so `tested` is the SDK in Mako's
 * lockfile and nothing is pinned: `cursor-agent` is only the CLI Settings
 * updates, on Cursor's own updates.
 *
 * The SDK continues a `cursor-agent` store by importing it, and the two are
 * one codebase (the SDK identifies `cursor-agent`'s runs by
 * `AGENT_CLI_STATIC_VERSION`) released apart: `cursor-agent` names each build
 * by its day, the SDK by a number npm dates. So a store is compared with the
 * day npm published the SDK. On 2026-10-17 the fields of the store's own
 * messages bore that out for SDK 1.0.31 to 1.0.38 against the builds of
 * 2026.09.28, 10.01 and 10.14 (`scripts/cursor-store-fields.ts`): no build
 * made by an SDK's publication day wrote a field that SDK lacks, other than
 * ones later builds dropped, and 9 of the 11 pairs with the build made after
 * did; the rule is cautious about the other two (1.0.34 with 10.01, 1.0.37
 * with 10.14).
 */
export const CURSOR_VERSIONS: HarnessVersions = {
  tested: "1.0.40",
  bundled: { package: "@cursor/sdk", version: "1.0.40", released: "2026-10-20T18:24:56.360Z", imports: "cursor-agent" },
  feed: { npm: "@cursor/sdk" },
  checked: {
    on: "2026-10-25",
    how: "@cursor/sdk 1.0.31 in Mako's lockfile, which the vocabulary, native-tools/cursor-1.0.31.json, the decoder fixtures and cursor-concepts.json name",
  },
}

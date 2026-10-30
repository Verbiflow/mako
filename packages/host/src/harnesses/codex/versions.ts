import type { HarnessVersions } from "../../contracts/harness-versions.js"

/**
 * The Codex CLIs Mako runs. Its sessions run the `codex` a person installed,
 * so installs and Update go to `tested` (`@openai/codex@<tested>` from npm;
 * Homebrew can't pin, so a brew install stays on brew's version and runs if
 * it is at least `oldest`). `scripts/bump-harness-versions.ts` moves
 * `tested`; `test-harness-definitions.ts` holds the vocabulary, native-tools,
 * decoder and concepts records to it.
 */
export const CODEX_VERSIONS: HarnessVersions = {
  oldest: "0.142.0",
  tested: "0.166.0",
  feed: { npm: "@openai/codex" },
  checked: {
    on: "2026-10-30",
    how: "harness:decode-pairs against the scripted model with --native builds: 0.142.0 through 0.145.0 run all 21 scenarios with only the known differences (0.142.0's kept as pairs), and every method Mako calls is in 0.142.0's generated protocol; 0.141.0 and older keep no item ids in their rollouts, so a streamed reply has no record to join and draws twice live. 0.164.0 is the version every record names",
  },
}

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
  oldest: "0.146.0",
  tested: "0.164.0",
  feed: { npm: "@openai/codex" },
  checked: {
    on: "2026-10-25",
    how: "harness:decode-pairs against the scripted model with --native builds: 0.146.0 through 0.150.0 run all 21 scenarios with only 0.159.3's known differences, while 0.145.0 and 0.140.0 draw a steered message differently from their rollout; 0.159.3 is the version every record names",
  },
}

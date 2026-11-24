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
  tested: "0.172.0",
  feed: { npm: "@openai/codex" },
  checked: {
    on: "2026-11-24",
    how: "0.170.0: 24 live/store flows against the scripted model, 26 native tools across 33 model/plan/Apex configurations, self-report and 84 officially generated input types. Oldest retained from sealed --native checks: 0.142.0 through 0.145.0 run all 21 scenarios with the known differences (0.142.0's kept as pairs), and every called method is in 0.142.0's protocol; 0.141.0 and older keep no item ids in rollouts, so a streamed reply has no record to join and draws twice live",
  },
}

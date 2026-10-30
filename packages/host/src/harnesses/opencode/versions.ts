import type { HarnessVersions } from "../../contracts/harness-versions.js"

/**
 * The OpenCode servers Mako runs. `oldest` is the first OpenCode 2 release,
 * whose sessions Mako runs as it runs `tested`'s: a server without
 * `/api/info` (before 2.0.6) is named by its executable (`native-api.ts`),
 * and one before 2.0.4 is spoken to in its own API (`legacy-api.ts`). No
 * feature needs a later release, so none declares a floor.
 * `tested` is the version of the `@opencode/client` Mako speaks it with,
 * published with that server (`scripts/test-opencode-updates.ts` holds the
 * two equal). Installs and Update go to `tested`; a newer release someone
 * runs is kept and run.
 */
export const OPENCODE_VERSIONS = {
  oldest: "2.0.0",
  tested: "2.2.3",
  feed: { npm: "@opencode/cli" },
  client: { package: "@opencode/client" },
  checked: {
    on: "2026-10-30",
    how: "tested: @opencode/client 2.1.4, which the vocabulary, native-tools/opencode-2.1.4.json, the decode pairs and opencode-concepts.json name, and harness:decode-pairs against the scripted model passes on 2.1.4. oldest: harness:decode-pairs on each release from 2.0.0 to 2.0.6 draws what it draws on 2.0.27 (21 scenarios the same, 7 skipped, and the one store-only note on stopped-shell), differing only in OpenCode's own shell output wording; the requests Mako sends that it doesn't (adding an MCP server, a slash command, both forks, a form's state and its cancel) answer on 2.0.0, 2.0.1 and 2.0.3 as on 2.0.27. Prereleases run from dev build 19656, the first with 2.0.4's API",
  },
} as const satisfies HarnessVersions

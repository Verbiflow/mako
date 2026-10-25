import type { HarnessVersions } from "../../contracts/harness-versions.js"

/**
 * Claude Code sessions run the build the Agent SDK in Mako's lockfile ships
 * (`claudeRuntime`), so `tested` is that build, the SDK's
 * `claudeCodeVersion`, and nothing is pinned: the `claude` in a terminal
 * stays on Anthropic's own updates.
 */
export const CLAUDE_VERSIONS: HarnessVersions = {
  tested: "2.1.310",
  bundled: { package: "@anthropic-ai/claude-agent-sdk", version: "0.3.310" },
  feed: { npm: "@anthropic-ai/claude-agent-sdk" },
  checked: {
    on: "2026-10-25",
    how: "the Claude Code build @anthropic-ai/claude-agent-sdk 0.3.283 ships, which the vocabulary, native-tools/claude-2.1.283.json and the decoder fixtures name",
  },
}

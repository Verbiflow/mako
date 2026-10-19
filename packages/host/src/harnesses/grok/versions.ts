import type { HarnessVersions } from "../../contracts/harness-versions.js"

/**
 * The Grok CLIs Mako runs. Its sessions run the `grok` a person installed,
 * so installs and Update go to `tested`: its installer takes the version
 * (`bash -s <tested>`) and npm `@xai-official/grok@<tested>`. Grok's own
 * `update` goes to the vendor's newest, so Mako's Update runs the pinned
 * installer instead. Where Grok's ACP handshake advertises a capability,
 * that answers instead of a version, so no feature names one.
 */
export const GROK_VERSIONS: HarnessVersions = {
  oldest: "1.0.25",
  tested: "1.0.46",
  feed: { npm: "@xai-official/grok" },
  releases: { npm: "@xai-official/grok" },
  checked: {
    on: "2026-10-12",
    how: "harness:decode-pairs against the scripted model with --native builds: 1.0.25, 1.0.30, 1.0.40 and 1.0.44 run all 23 scenarios with exactly 1.0.46's differences, while 1.0.24 and older (1.0.22-1.0.24, 1.0.20, 1.0.10, 1.0.0) store sessions whose prompts Mako's reader doesn't draw; 1.0.46 is the version every record names",
  },
}

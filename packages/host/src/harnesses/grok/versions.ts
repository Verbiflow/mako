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
  oldest: "0.2.97",
  tested: "1.0.70",
  feed: { npm: "@xai-official/grok" },
  releases: { npm: "@xai-official/grok" },
  checked: {
    on: "2026-10-25",
    how: "harness:decode-pairs against the scripted model with --native builds: 0.2.97, 1.0.0, 1.0.10, 1.0.20 and 1.0.24 run every scenario, and 0.2.97's pairs are kept. Before 1.0.25 Grok echoes each prompt back, which the ACP decoder takes as the prompt it sent (`AcpUpdateDecoder.sent`); through 1.0.20 it saves a steered message in its own wrapper, which history reads as the steer (`grokWrappedSteer`); through 1.0.10 it writes a failed turn's prompt after the failure, which history reads in the order of their times; and it reports a watch's end otherwise, the one difference left. 0.2.96 and older report no spend for a turn, and 0.2.85 and older name no tool their calls ran or break plan mode. 1.0.70 is the version every record names",
  },
}

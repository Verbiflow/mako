# Streaming cleanup

September 25, 2026. Tracked by [Wayfinder LC-26](local-control-map.md#lc-26--packaging-dependency-size-and-stale-code), covering the [LC-21 media path](local-control-map.md#lc-21--responsive-capture-recordings-and-cursor).

## Removed

| Removal | Caller evidence and replacement |
| --- | --- |
| Ordinary-RPC Brotli decoder and obsolete compression metric | Neither source `web-host.ts` nor the installed app's archived host emits compressed RPC. Neither RPC nor binary-preview clients negotiate it. RPC now accepts bounded identity JSON; malformed, oversized and unexpected-encoding replies remain unknown outcomes and are never replayed. Preview pixels already use the dedicated binary protocol. |
| Staged-browser post-stop encoding branches | Browser recordings always create the continuous encoder. Native recordings attach a driver video. The remaining post-stop renderer is explicitly a native cursor-overlay compositor; it refuses a missing source video rather than retaining an unreachable image-only encoder. |
| `scripts/test-control-media.ts` | No script or documentation calls it. Its Electron resources/old vendor-path assumptions were obsolete. `packages/control-runtime/test/media.mjs` covers the current Node resolver, explicit configuration, packaged resource relocation and missing-binary refusal. |
| FFmpeg concat demuxer | Browser frames no longer use a concat file. Native overlays use raw frames over stdin plus the driver's video. Recipe 4 removes concat while preserving hardware encoding, PNG/image2, MOV and rawvideo. |
| Hardcoded software codec in the continuity audit | The experiment now imports the shared platform encoding policy, so its container/recovery comparison exercises the current codec. Historical reports retain their original settings. |

## Deliberately retained

- Native video pass-through and cursor overlay both have live callers. Pass-through preserves the driver's bytes when no transformation is needed.
- Linux software encoding remains the supported policy until cloud-agent display, hardware and lifecycle requirements are defined. Mac recording requires VideoToolbox hardware; it does not silently fall back to software.
- HTML image decoding remains necessary for PNG and viewers without JPEG `ImageDecoder` support. It is covered by pixel and resource-lifecycle checks.
- CDP/native snapshot base64 is part of those upstream protocols, not the retired JSON preview transport. The shared preview transport carries binary image bytes.
- Explicit host/client version refusal and uncertain-outcome handling protect rolling updates. Removing them would hide interruptions or allow duplicate actions.
- Audit baselines remain comparison tools, outside production dispatch. Build caches and unique acceptance evidence remain available for reproducibility.

## Validation and artifacts

Passed after the cleanup:

- Electron/shared-engine build and all bounded TypeScript projects.
- Full preview suite: exact JSON/pixels, binary framing, malformed/oversized responses, cancellation, ownership, bounded retention, hidden-view cleanup and no replay.
- Full recording suite: continuous browser encoding, native overlay/pass-through, interrupted/failed jobs, stalled pipes, queue limits, target/session ownership and capture-rate negotiation.
- Separate minute-long 1080p continuous-recording check: no staged source images, readable output during capture, forced-encoder-exit recovery and byte-identical native pass-through.
- Node media resolver tests and the six-arm container experiment with recipe 4. Fragmented and hybrid recordings retain a readable 120-frame prefix after forced termination; clean recordings decode all 180 frames.
- Full repository lint: zero errors, five existing React warnings.
- Recipe-4 executable hashes match provenance. Only system dynamic libraries are linked; concat is absent, and VideoToolbox/x264/PNG encoders remain present.

The validated recipe-4 binaries now occupy the standard ignored `vendor/control-media/darwin-arm64/` directory. Three retired local build copies were removed after saving their provenance and verifying hashes: **71,158,543 bytes** of temporary duplicate builds. The active media directory is **23,686,325 bytes**, only **33,182 bytes smaller** than recipe 3; this cleanup is not a large release-size or performance claim. Source archives and license files remain in the active payload. Existing ignores cover generated media, Python caches and audit artifacts.

Evidence: `docs/audits/2026-09-25/streaming-cleanup/` (ignored logs, container report, active and retired build provenance). Existing compiler-output pruning still runs in the build; no obsolete source module was retained as a compiled compatibility shim.

**Deployment boundary (updated September 25):** installed build `9b696b0d9525e7e9`
includes this cleanup and recipe 4. The running host matches the installed bundle;
strict certificate-backed signature, reviewed media-module equality and installed
packaged browser/native encoding checks pass. A redundant rebuild is unnecessary.
[Installed media acceptance](local-control-installed-media.md) records ordinary
Aside success, loaded recording interruptions and missing native right-click cursor
events. Cleanup deployment is complete; those LC-21 acceptance failures remain.
Cloud/Linux streaming work stays deferred until the cloud-agent environment is defined.

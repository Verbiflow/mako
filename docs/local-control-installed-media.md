# Installed Mac media acceptance

September 25, 2026. [Wayfinder LC-21](local-control-map.md#lc-21--responsive-capture-recordings-and-cursor).

Follow-up: [native cursor fix and source-host sustained recording results](local-control-media-fixes.md).
The installed-build results below remain scoped to this checkpoint.
For the newer installed combined build, see [the follow-up](#combined-build-installed-follow-up).

Cleanup deployment is complete. Installed media acceptance is **not complete**:
ordinary browser recording works, but sustained loaded recording interrupts and
native right-click events are missing from the recording cursor track. No product
source was changed during this acceptance run. The new tooling borrows the current
task's SDK session and uses the installed host; it does not launch a replacement
control service or replay uncertain actions.

## Exact deployment

- Installed/running build: `9b696b0d9525e7e9`, built at
  `2026-09-25T08:11:37.168Z`, revision `336233c50ff80afb65e52fa714b6cb69a0b90f0b`
  with a dirty source marker. Build identity, not revision alone, identifies it.
- `/Applications/Mako.app` passes strict certificate-backed signature verification.
  Running host PID 9015 reports the same build as the installed bundle.
- Six recording/media modules in ASAR match the reviewed local compiled modules
  byte-for-byte. Installed ordinary-RPC response code also matches the cleanup.
- Media recipe 4 includes the removed concat demuxer and H.264 VideoToolbox,
  quality 85, with software fallback disabled. The installed packaged encoder and
  native synthetic cursor-composition checks pass with PATH restricted to system
  directories. This does not certify every live native cursor dispatch route.
- Signing changes Mach-O bytes. Evidence records pre-sign provenance and actual
  signed hashes separately; strict bundle verification authenticates deployed bytes.
- Aside's regular Work profile was used through the extension. The selected Mac
  driver is `0.28.2+mako.21`. No other browser/profile or direct-debugging fallback
  was substituted. No redundant desktop rebuild/install was performed.

## Results

| Job | Result | Evidence |
| --- | --- | --- |
| Ordinary 60-second Aside workload, two viewers plus recording | Pass: 56.84 distinct preview fps, 57.73 distinct recorded fps; video finishes at 66.83 seconds / 1920×1080. All 36 exact inputs and both screenshot-pixel comparisons pass. | `ordinary/` |
| First 120-second loaded job, two SHA-256 workers | Fail: recording interrupts at 71.74 seconds with a playable 69-second prefix. Input checks ran after load/recording stopped and cannot establish loaded latency. | `loaded-before-audit-correction/` |
| Corrected 120-second loaded job | Fail: recording interrupts at 119.84 seconds with a playable 117-second prefix. Preview 54.81 distinct fps; recorded prefix 55.79. All 36 exact inputs occur at 10.1–15.5 seconds while recording and load are active. Both screenshot-pixel comparisons pass. | `loaded-active-input/` |
| Own-tab debugger release, interruption and reclaim | Pass: 3.02-second interrupted prefix decodes; released handle refuses; observed same tab is reclaimed under a fresh lease; second recording finishes at 1.62 seconds. Exactly two verified saves, no replay. | `recovery/result.json`, browser fields |
| Native AppKit job, recording and two live previews | Six exact whitespace/Unicode edits and saves pass. Video finishes at 16.85 seconds / 480×232. Both preview viewers deliver 859 frames over 15 seconds (57.26 fps). Fixture never foreground in 110 samples. **Cursor gate fails:** actual right-click dispatch is absent from recording timeline. | `native-final/` |
| Installed packaged encoding/composition | Browser and synthetic native cursor output decode with correct dimensions/pixels and hardware policy. | `packaged/` |

All evidence directories above are under ignored local
`docs/audits/2026-09-25/installed-media/`. Logs, JSON reports, videos, timeline and
resource samples are retained there; no private session descriptor is copied.
The recovery script's aggregate status is failed because its initial native fixture
assumption failed after the browser checks passed. Later native attempts and their
failures remain alongside the final result; successful browser subchecks do not
turn that aggregate result into a pass.

The native rates are delivered video frames, not distinct animated frames, and
480×232 is not native 1080p acceptance. Browser rates decode fixture motion markers;
constant-rate encoded duplicate frames do not count as distinct source frames.

## Latency and resources

Input-to-visible-result measurements end at the production React fixture's
**offscreen compositor**, not physical screen scanout. The fixture receives binary
preview frames from the actual installed host. It is a separate Electron process,
not the existing installed application's renderer instance.

| Measurement | Ordinary | Corrected loaded |
| --- | ---: | ---: |
| Click input → visible p95 | 81 ms | 121 ms |
| Type input → visible p95 | 87 ms | 73 ms |
| Scroll input → visible p95 | 84 ms | 82 ms |
| Host + encoder peak summed RSS, first 60 seconds | 769 MB | 863 MB |
| Host + encoder CPU equivalents, first 60 seconds | 1.37 cores | 1.67 cores |
| Encoder alone peak RSS | 202 MB | 240 MB |
| Encoder alone CPU equivalents | 0.28 cores | 0.29 cores |

These are live-host totals: other Mako tasks remain active. Summed RSS can count
shared pages more than once. The browser and extra viewer fixture are separate
resource groups, not included above. These measurements neither isolate the
recording's incremental cost nor include all GPU/media-engine power. First-minute
windows avoid averaging in time after an interrupted encoder exited. The corrected
loaded run starts at machine load 11.30 and ends at 13.90 on 14 logical CPUs.
Earlier source-host measurements of roughly 460 MB / 1.28 cores are a different
process boundary and cannot be substituted for installed results.

The ordinary audit originally measured input after its sustained preview loop,
while recording remained active. The first loaded run exposed that placement as
invalid for loaded latency. The audit now runs input ten seconds into the sustained
window and records recording status and timestamps. Both old results are retained.

## Failures and next work

1. **Sustained recording backlog.** Both loaded jobs hit the existing two-second
   encoder lag guard. The interrupted prefix remains playable, so recovery works;
   the requested complete recording does not. The hardware encoder itself consumes
   around 0.3 CPU cores in the active samples. Profile host-side JPEG decode,
   cursor composition, scheduling and RGBA delivery before choosing the next
   optimization. This measurement does not establish which stage causes the lag.
   Keep the lag/queue bounds, text quality and exact screenshot behavior. Repeat
   loaded installed acceptance and measure against a matched idle-host baseline.
2. **Native pointer recording scope.** Semantic AppKit button clicks can use
   AXPress and correctly produce no pointer event. To distinguish that from lost
   events, the final fixture also issues a real right-click on known blank content.
   Its dispatch receipt reports background `window-pointer`; driver evidence names
   `macos_cg_event_pid` / `synthetic_events`. Both `pointer_dispatches` and final
   timeline pointer entries are empty. The pinned base's `right_click.rs` uses
   plain `tokio::task::spawn_blocking` at the dispatch boundary; release.patch has
   no right-click hunk, despite adding a recording-scope-preserving helper for
   other routes. This is the likely propagation defect. Apply the shared helper,
   inspect the other gesture worker boundaries, rebuild/sign the driver and prove
   real dispatches appear in the installed recording before closing this gate.

Whole-browser process/extension-worker restart, forced extension update, physical
concurrent typing/IME and physical-screen latency are not established by these
runs. Scoped debugger release/reclaim is the interruption tested here. Foreground
sampling shows the native fixture did not activate; it is not physical typing
validation. Browser capture returns to hidden visibility, but the observed page
still reports `hasFocus: true`; this installed audit does not expose internal
emulation ownership counters and does not claim full focus-state restoration.

## Reproduction and tooling

Use an existing matching task descriptor; do not commit its path or credentials,
start another task session, or replace the active installed host. Discover the
saved browser ID and exact task conversation ID first.

```sh
node scripts/audit-control-preview.mjs \
  --installed-session=<existing-session-file> --conversation=<conversation-id> \
  --extension=<saved-browser-id> --browser-pid=<browser-root-pid> \
  --two-viewers --recording --seconds=60

node scripts/audit-control-preview.mjs \
  --installed-session=<existing-session-file> --conversation=<conversation-id> \
  --extension=<saved-browser-id> --browser-pid=<browser-root-pid> \
  --two-viewers --recording --seconds=120 --load-workers=2

node scripts/audit-installed-control-recovery.mjs \
  <existing-session-file> <saved-browser-id> <evidence-directory> \
  --preview-dist=<preview-audit-dist-directory> --conversation=<conversation-id>
```

The preview audit builds the production component fixture and reports its output
directory. `--native-only` skips the recovery script's browser phase when repeating
the native gate. The helper verifies installed host/build/signature/module identity
before testing. The scripts clean up only their owned tabs, fixture and recordings;
other sessions remain running. A complete lint run passes with zero errors and five
existing React warnings. New script syntax and diff whitespace checks pass.

Cloud Linux streaming implementation remains deferred until its environment is
defined; this Mac result does not choose Selkies, Moonlight or another cloud backend.

## Combined build installed follow-up

The full-workspace build `1fb3bfb7b3d14e96` (21:51:28 UTC) is installed and running
in default host PID 20718. Its native daemon PID 25450 loads the immutable +mako.23
binary. The build includes the other contributor's changes; the 1,907-file source
manifest and ASAR comparisons are in `release/combined-local-20260925/`.

Automatic bundled recording, MCP/browser/native recovery and private native
idle/cursor checks pass. The fresh actual task's `live-recovery/result.json` also
passes: Aside debugger release retains a playable 2.73-second prefix, stale handles
refuse, reclaim resumes recording, and six native whitespace/Unicode saves retain
exact values. Native recording finishes at 15.3 seconds / 480×232, with the actual
right-click's three pointer samples now present. The fixture stayed out of the
foreground in 104 samples. This does not establish native 1080p or physical typing.

The separate two-minute preview job executes installed modules in an isolated
host. Preview reaches 56.12 distinct fps with all 36 exact input checks and both
screenshot-pixel checks passing. Click/type/scroll input-to-offscreen-visible p95
is 142/153/127 ms. Recording interrupts at 50.10 seconds when encoder lag exceeds
two seconds. The retained video is 47 seconds / 1920×1080 / 53.06 distinct fps,
with no invalid decoded marker samples. This is a failed complete job.

Resource measurements over the first 44.79 seconds, while recording is active,
show 1.25 host-plus-encoder CPU cores and 432 MB peak summed RSS. The encoder alone
uses 0.266 cores / 187 MB; fixture including host/viewers uses 1.90 cores / 993 MB.
The whole existing Aside browser uses 2.48 cores / 4.56 GB; that includes unrelated
tabs. These groups overlap. GPU/media-engine power is not measured. The 120-second
average includes the stopped encoder and must not represent active recording cost.

Timing totals show the last 240 outputs (frames 2640–2880) took 5.98 seconds for
four seconds of video. Rendering accounts for 4.95 seconds and pipe admission for
3.87 seconds, with overlap. Lag rises from near zero to 1.98 seconds. The worker
already overlaps one render with one ordered write; neither queue expansion nor
a relaxed lag guard is justified. The underlying scheduling/throughput cause is
still unproven.

A separate borrowed-task right/double-click proof aborted at fixture startup.
Mako PID 20703 was frontmost at window creation; 43 ms later the fixture activated,
before any control call (`calls: []`). Its initial `orderBack` did not prevent
AppKit startup activation. Correct the fixture's launch lifecycle before repeating
this test; do not count it as a driver-action failure or a passing gesture test.

Reports are retained under ignored `docs/audits/2026-09-25/installed-combined/`:
`live-recovery/`, `preview-failure/`, and `native-startup-failure.json`. The latter
preserves the failed startup event trace. No private session descriptor is copied.

Settings separately retains an old error from `updates/install-result.json`.
`LocalUpdates.load()` reads it while the CLI installer uses a different receipt.
Verified installation succeeded; receipt reconciliation remains a product fix.
The earlier cross-profile automatic host-wake race also remains a follow-up.


September 25 follow-up: the first idle installer aborted on host replacement.
The signed `1fb3bfb7b3d14e96` candidate and driver +23 now include guarded installer
helper cleanup and connected implicit-session lifetime, with candidate MCP,
recording and real idle/native-cursor checks passing. The original foreground
counterexample remains unresolved. See the [follow-up report](local-control-media-fixes.md#installed-follow-up-september-25)
and [current installer receipt](../release/media-followup-20260925/install-state.json)
for rollout state; this historical report is not evidence that the new candidate
is already installed.

# Mac hardware recording

September 25, 2026. Historical source implementation/candidate measurements below.
The newer recipe-4 build `9b696b0d9525e7e9` is now installed and signed; see
[installed media acceptance](local-control-installed-media.md). Ordinary installed
recording passes, but two loaded runs interrupt and a native right-click is absent
from the cursor timeline. Earlier candidate success does not close these gates.
Current status belongs to [Wayfinder](local-control-map.md#delivery-order).

## Implementation

Browser continuous recording and native cursor-overlay encoding share the same
platform policy in `packages/control-runtime/src/control-media.ts`. Mac uses H.264
VideoToolbox, quality 85, realtime mode, no B-frames and `allow_sw=0`. FFmpeg's pinned
source maps the latter to Apple's `RequireHardwareAcceleratedVideoEncoder` setting.
A successful encoded output therefore requires hardware admission. Merely listing
an encoder is not evidence of successful hardware initialization.

The preflight rejects a binary missing the codec before capture. Initialization
failure stops capture and reports failure; it does not retry through a software
encoder or replay input. Existing native recordings that need no transformation
retain their original bytes. Linux retains its existing x264 policy.

The recording timeline includes the configured codec, hardware requirement and
arguments for the routes that encode in this engine. Native pass-through output
makes no inferred hardware claim. Queue budgets, geometry, exact screenshots,
target ownership, fragmented output and verified interruption prefixes are unchanged.
Consecutive byte-identical queued images now share storage. The first timestamp,
every source observation and all cursor events are retained; intervening different
images and coordinate geometry prevent coalescing. This fixes a static noisy-screen
stress failure without increasing the queue budget or discarding visual transitions.

Recipe 3 builds VideoToolbox explicitly because the minimal previous FFmpeg build
had it disabled. FFmpeg remains pinned to 8.0.1 and x264 to its reviewed revision.
The build permits only system dynamic dependencies and retains source/license
artifacts. Candidates build to a separate immutable directory; generated binaries
and source archives stay ignored. This change adds roughly 0.1 MB to each binary,
not an additional runtime or framework bundle.

This is hardware encoding after the existing JPEG decode, cursor composition and
RGBA pipe. It is not native-buffer/zero-copy capture. Host-side image work remains
measurable and is the next resource cost to address if needed.

## Final quality-85 candidate

Signed candidate `b5ec839840ea7ab0` at
`release/mac-hardware-recording/mac-arm64/Mako.app` includes the hardware policy
and exact-repeat coalescing. Packaged browser/native cursor checks pass with PATH
restricted to system directories. Compiled media modules match the packaged ASAR
byte-for-byte; package/import/size/startup/signature checks pass. The package is
663,276,692 bytes for darwin-arm64. Sources/licenses are retained; no wrong-target
binaries or Python caches enter the package. The readiness check reports a running
Mako/shared host, so this candidate is **not installed**.

The final ordinary two-viewer Aside run passes: **58.72 preview / 58.85 recorded
fps**, 67.17 seconds of 1920×1080 recording, 36 exact inputs and zero screenshot
pixel differences. Source and binary hashes match before/after. Host plus encoder
used **456 MB peak summed RSS / 1.32 CPU cores**; the visible VideoToolbox service
added **22 MB / 0.018 cores**. Encoder alone peaked at 190 MB. The separately measured
viewer fixture and entire browser are excluded from those totals. Same-fixture
software evidence was about 1.05 GB / 2.01 cores; workload and system conditions vary,
so this is observational, not a controlled claim about all resource savings.

Final quality-85 recorder-only acceptance also passes: 60.23 seconds, 3,614 decoded
frames, a verified interrupted prefix on forced encoder death and unchanged native
pass-through bytes. This is lifetime/recovery evidence, not distinct-motion fps.
The final two-worker loaded Aside job also passes: **58.79 preview / 58.63 recorded
fps**, 127.03 seconds of video, 36 exact inputs, no invalid motion markers and zero
screenshot differences. Maximum recorded hold is 83.3 ms; click/type/scroll p95
input-to-visible times are 97.6/92.9/95.4 ms (offscreen compositor, not physical
scanout). Host plus encoder used **460 MB / 1.28 cores**; visible OS encoder service
added 22 MB / 0.018 cores. Maximum queued source bytes were 2.70 MB and schedule
lag 202 ms. Source/binary hashes match before and after. Machine load was 11.85 at
start and 13.63 at end on this 14-logical-CPU Mac. This closes the declared loaded
workload for the candidate, not arbitrary overload, all Mac hardware or installed
media acceptance. Earlier failures remain below. Remaining optimizations include
native buffers and avoiding repeated encoding of static pixels.

## Acceptance

The candidate passes browser/native cursor output, actual frame dimensions, mixed
source sizes, overflow refusal, encoder/host death, short stalls, backlog limits,
long stalls, startup failure and ownership cleanup tests. Missing codec refusal
and advertised-but-failed initialization are separately tested. The previous
software-only binary refuses before capture. Typecheck passes; full lint has no
errors (five existing React warnings) at that checkpoint. A later whole-tree
anti-slop rerun is blocked by concurrently added, unrelated files:
`electron/providers/claude/permission-observer.ts:94` and
`electron/providers/claude/approval-telemetry-settings.ts:22` (`no-runtime-typeof`).
The media files pass the scoped lint check. Those provider files were not changed
for this work; the earlier complete lint result and final failure are retained.

The initial quality-80 source-host/installed-Aside run used two production preview viewers,
recording and exact click/type/scroll checks. Source and binary hashes matched
before and after. It finished a 67.43-second 1920×1080 recording, with all 36 inputs
correct and zero changed pixels in both explicit screenshot comparisons. Recorded
motion reached 56.17 distinct fps; preview reached 54.97. The preview missed the
unchanged 55 fps floor, so this is not a complete performance pass.

| Process scope | Previous software run | Hardware quality-80 ordinary run |
| --- | --- | --- |
| Host + encoder peak summed RSS | ~1.05 GB | 547 MB |
| Host + encoder CPU equivalents | 2.01 cores | 1.55 cores |
| Encoder peak RSS | 756 MB | 237 MB |
| Encoder CPU equivalents | See original evidence | 0.35 cores |
| Visible VideoToolbox service | Not sampled | 23 MB / 0.02 cores |

These are successive runs of the same fixture, not simultaneous paired samples.
Machine load, other browser tabs and OS scheduling vary. Summed RSS can double-count
shared pages. The OS-service group includes other apps using that service; GPU and
media-engine power are not measured. The Electron viewer and entire browser are
reported separately, not included in host-plus-encoder numbers. The result reduces
cost; it does not establish a one-core whole-job budget or equivalent cloud costs.

Ordinary artifacts: `mako-preview-latency-mTfGO2` under the system temporary directory.
The loaded 120-second job interrupted recording at 54.07 seconds and retained a
verified 51-second/3,060-frame prefix. Recorded-prefix motion was 53.47 fps and the
full-run preview was 48.66 fps; exact inputs/pixels remained correct. Host-plus-
encoder peak RSS was 552 MB. Its full-run CPU average includes time after recording
stopped and must not be compared as a sustained recording improvement. The machine
load rose from 9.47 to 17.46. This workload remains an open performance gate.

A subsequent static noisy-screen run exposed duplicate source images exhausting
queue bytes. After exact-repeat coalescing, the 60.17-second recorder-only run
completed, maximum queued bytes were 1.71 MB, forced encoder death retained a
verified prefix, and native no-transform output remained byte-identical. This
static run does not close the moving-content loaded failure.

The same packaged FFmpeg encoded both software and initial quality-80 hardware samples. Both
decode to 240 frames at 1920×1080, four seconds. All six sampled text regions had
less squared reconstruction error with hardware (4.35–4.69 versus 4.70–6.71).
Hardware output was 776,072 bytes versus 640,930 bytes, about 21% larger. This
supports the chosen setting on the fixture, not universal font/color equivalence.
The PNG decode path differs from the earlier system-FFmpeg raw-pixel probe; compare
within each matched run. The decoded cursor/text image was also inspected visually.

The broader built-in colored-text fixture rejected quality 80: three samples had
slightly higher text error than software (worst 3.83 versus 3.64). Quality 85 passes
all six samples at 3.03–3.08 versus software's 3.52–4.88. Its video is 1,376,389
bytes versus 1,022,657 bytes, about 35% larger. Quality 85 is the selected default;
quality-80 resource/rate measurements above remain labeled as earlier evidence.
The original browser fixture also passes at the final quality 85: all six text
samples improve to 3.61–3.70 versus software's 4.70–6.71. Its clip grows to 971,429
bytes versus 640,930 bytes, about 52% larger. Both final fixtures decode to exactly
240 frames at 1920×1080/four seconds. These 35–52% size costs buy the tested text
quality; the selected setting is not a bitrate-equivalent comparison.
The stricter quality gate remains in the reusable audit script. A better result
on these fixtures is not a guarantee across every font, color or codec input.

Evidence: `docs/audits/2026-09-25/mac-hardware-recording/` (ignored local artifacts).
The reproduction script works without those artifacts using its built-in fixture.

## Reproduction

Build the shared engine and candidate media recipe, then set
`MAKO_CONTROL_MEDIA_ROOT` to the candidate's absolute directory. Run:

```sh
npm run test:control-recording
npm run test:control-recording-continuous
node scripts/audit-control-video-encoding.mjs
node scripts/audit-control-preview.mjs --shared-host --extension=<saved-browser-id> --two-viewers --recording --seconds=60 --browser-pid=<browser-root-pid>
node scripts/audit-control-preview.mjs --shared-host --extension=<saved-browser-id> --two-viewers --recording --seconds=120 --load-workers=2 --browser-pid=<browser-root-pid>
```

Run performance jobs separately from builds and other benchmarks. The encoding
probe creates its own text/cursor fixture or accepts `--image=<fixture-path>`;
it verifies decoded geometry/count/duration and reports sampled reconstruction
error for software and hardware using the same packaged FFmpeg. Its four seconds
of content are not sustained browser acceptance.

## Cloud ordering

Define the Linux cloud-agent environment before implementing its new media backend:
display/compositor, hardware availability, isolation, network and lifecycle. Keep
existing Linux functionality and earlier prototype evidence. Platform backends
share the same SDK/session/ownership; a different media encoder does not introduce
a separate control system or a separate agent API.

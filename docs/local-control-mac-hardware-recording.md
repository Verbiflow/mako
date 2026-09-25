# Mac hardware recording

September 25, 2026. Source implementation and candidate validation; not installed.
Current status belongs to [Wayfinder](local-control-map.md#delivery-order).

## Implementation

Browser continuous recording and native cursor-overlay encoding share the same
platform policy in `packages/control-runtime/src/control-media.ts`. Mac uses H.264
VideoToolbox, quality 80, realtime mode, no B-frames and `allow_sw=0`. FFmpeg's pinned
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

## Acceptance

The candidate passes browser/native cursor output, actual frame dimensions, mixed
source sizes, overflow refusal, encoder/host death, short stalls, backlog limits,
long stalls, startup failure and ownership cleanup tests. Missing codec refusal
and advertised-but-failed initialization are separately tested. The previous
software-only binary refuses before capture. Typecheck passes; full lint has no
errors (five existing React warnings).

The first source-host/installed-Aside run used two production preview viewers,
recording and exact click/type/scroll checks. Source and binary hashes matched
before and after. It finished a 67.43-second 1920×1080 recording, with all 36 inputs
correct and zero changed pixels in both explicit screenshot comparisons. Recorded
motion reached 56.17 distinct fps; preview reached 54.97. The preview missed the
unchanged 55 fps floor, so this is not a complete performance pass.

| Process scope | Previous software run | Hardware ordinary run |
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

The same packaged FFmpeg encoded both software and hardware quality samples. Both
decode to 240 frames at 1920×1080, four seconds. All six sampled text regions had
less squared reconstruction error with hardware (4.35–4.69 versus 4.70–6.71).
Hardware output was 776,072 bytes versus 640,930 bytes, about 21% larger. This
supports the chosen setting on the fixture, not universal font/color equivalence.
The PNG decode path differs from the earlier system-FFmpeg raw-pixel probe; compare
within each matched run. The decoded cursor/text image was also inspected visually.

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

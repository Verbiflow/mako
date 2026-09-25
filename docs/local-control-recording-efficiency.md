# Recording efficiency and Linux media experiments

September 24, 2026. Follow-up to [binary previews](local-control-preview-binary.md)
and [Wayfinder LC-21](local-control-map.md#lc-21--responsive-capture-recordings-and-cursor).
Source changes and experiments are in progress; none of these changes is installed.

## Recorder findings

The first complete resource sample used regular-profile Aside, two viewers,
1080p recording and two synthetic CPU workloads for one minute. It completed
67.47 seconds of recording, passed all 36 inputs and both pixel comparisons,
and reached 53.36 preview / 53.60 distinct recorded fps. No decoded markers were
invalid; the longest recorded hold was 100 ms. It misses the normal 55 fps audit
floor. Maximum encoder lag was 1.891 seconds, close to the unchanged two-second
interruption bound.

The recording host plus FFmpeg averaged 1.97 CPU cores; FFmpeg alone averaged
0.95 and peaked at 728 MB resident memory. The entire Aside process tree averaged
2.27 cores, including the user's other tabs. That number cannot be attributed
solely to Mako. The resource sampler now includes these previously missing costs.
Process RSS sums may count shared pages more than once. Sampling uses process
names, IDs, CPU time and RSS; no command arguments or environment secrets.

The timeline now accumulates render, pipe, worker-wait, source metadata and
journal time, plus changed-frame counts, without retaining per-frame timing arrays.
In that run, 4,049 output frames spent 31.12 seconds rendering and 20.15 seconds
awaiting pipe admission. Source metadata used 4.18 seconds across 3,866 accepted
frames. Host event-loop delay peaked at 97.5 ms. These are wall-time stage totals,
not exclusive CPU time or proof that metadata alone caused interruptions.

The retained changes are:

- Rasterize the cursor and press ring once into 7 KiB of immutable RGBA artwork.
  Previously every changed frame decoded SVG and encoded a PNG for composition.
  Fifty-six exact comparisons include clipping, scale and transparent native
  overlays. Four matched 240-frame encodes were byte-identical. Node rendering
  CPU fell about 9% in the small alternating comparison; throughput varied, so
  this is not a measured full-path speedup.
- Overlap rendering and pipe delivery with at most two pending frames. Writes and
  acknowledgments stay ordered; cancellation and playable-prefix recovery share
  the existing worker lifecycle.
- Read source dimensions from bounded image headers instead of dispatching a
  duplicate Sharp metadata job. The worker still decodes every changed image.
- Limit conversion to one filter thread while keeping x264's automatic encoder
  parallelism. Four matched videos remain byte-identical; no memory saving was
  observed. Resolution, CRF 18, `fast`, history and interruption bounds remain.

An experiment limiting x264 to two threads used 433 MB instead of 770–821 MB in
a small repeated-background benchmark. It did not survive the real workload.

The two-thread encoder candidate is **rejected**: the full two-viewer/two-load-worker
run interrupted after 3.64 seconds and retained one verified playable second.
Its mean pipe wait grew to 21.5 ms/frame; small synthetic capacity tests did not
predict the real workload. x264's automatic encoder parallelism is restored;
only the conversion-thread limit is retained. The intended two-minute
fixture also needs an explicit recording limit above its measurement duration;
the script now reserves thirty seconds for its later verification/cleanup steps.

The rejected x264 threading experiment changes compressed pixels: it is not a bit-identical optimization.
Six sampled frames compared against exact pre-encoder RGBA had at most 0.00025 dB
PSNR difference; the sampled dense-text region had identical error. The cursor
composition itself remains pixel-identical. Explicit screenshots never enter this
lossy recording path.

## Loaded recording result

The serial render-then-write path still interrupted after 21.12 seconds with
conversion threads limited. Overlapping at most two frames extended that run to
85.81 seconds but still interrupted. Both failures remain evidence, not passes.

The final candidate also replaces the duplicate asynchronous Sharp metadata job
with the same bounded image-header reader already used by capture. Full pixel
decoding still happens in the recording worker before acknowledgment. Malformed
headers and the 16-million-pixel limit remain explicit failures. This removes one
libvips dispatch per source frame rather than trusting page viewport metadata.

The two-minute Aside run with two viewers and two CPU workloads then completed
127.35 seconds of video: 7,642 encoded frames, **55.11 distinct recorded fps** over
the measured interval, zero invalid markers and a 150 ms longest recorded hold.
All 36 inputs and both full-frame pixel comparisons passed; 574 foreground samples
remained Aside. Click/type/scroll p95 was 106/180/92 ms. Source timestamp validation
rejected 11 out-of-order frames; intentional sampling is reported separately.

Preview averaged **53.26 fps**, with p95/max gaps 33/227 ms. The ordinary 55 fps
preview gate still fails under this load. Do not describe this as sustained 60 fps
or a complete performance pass. That individual workload completes, but the final-source repeat below interrupts.
Heavy-load acceptance remains open; this successful run is not a reliability claim.

Maximum encoder schedule lag fell to 759 ms and queued source data peaked at
44 frames / 9.92 MB. Header reads took 137.5 ms across 7,413 source frames, about
0.019 ms each, versus roughly 1 ms for the earlier asynchronous metadata path.
Render and pipe work now overlap; summing their wall-time totals is not elapsed
time or CPU time. Pipe acknowledgments remain ordered and confirm admission.
The two-frame window is bounded at both host and worker, including failures.

Host plus encoder averaged 2.07 cores and peaked at 1.03 GB summed RSS; encoder
alone was 1.02 cores / 732 MB. This is still a substantial software recording cost.
The rejected two-thread x264 memory saving is **not shipped**. The final conversion-
only limit produced byte-identical matched MP4s but no observed memory saving.
The whole Aside tree used 2.62 cores, including unrelated tabs. Full fixture totals
also include the two synthetic CPU jobs and instrumentation and must not be labeled
as Mako-only CPU.

## Final-source verification

After a clean successful build, the final compiled two-viewer Aside minute passed
all ordinary gates: **55.84 preview / 56.15 distinct recorded fps**, zero invalid
markers, all 36 exact inputs and both 1920×1080 pixel comparisons. Recording
finished at 67.17 seconds. Preview p95/max gaps were 24.7/177.8 ms; click/type/scroll
p95 was 88/99/94 ms. Maximum encoder lag was 557 ms and source queue 7.46 MB.
Host plus encoder averaged 2.01 cores / 1.05 GB summed RSS; encoder alone peaked
at 756 MB. The before/after hashes of source and compiled media files match.
This is source-host acceptance with the installed Aside extension, not rollout
of the desktop package.

Build, all TypeScript projects, full lint, recording/preview regressions, packed
public consumer and Linux ARM64 recording worker pass. Full lint has five existing
React Compiler warnings and no errors. Failure coverage includes encoder/host
death, stalls, bounded backlog, playable-prefix recovery and owner cleanup.
Malformed and oversized image headers refuse; source tests load the matching
source worker and packaged tests verify the compiled worker is included.

The packed runtime archive is approximately 151 kB / 619 kB unpacked and the typed
control package 63 kB / 255 kB. Those figures exclude dependencies and native/media
binaries; they are not a desktop installation size. No upstream streaming stack,
Python bytecode, fixture recordings or prototype binaries enter these packages.

## Final-source heavy-load counterexample

The identity-checked repeat with the same two synthetic workloads **interrupted
after 56.44 seconds**, retaining a verified 53.00-second playable prefix. It
reports the two-second encoder-backlog error and preserves 3,180 decodable frames,
zero invalid markers and 54.34 distinct recorded fps over that prefix. Preview
continues for the full two-minute measurement at 48.29 fps, p95/max gap 47/383 ms.
All 36 input checks and both exact pixel comparisons still pass. Click/type/scroll
p95 is 135/130/265 ms. Source and compiled-media hashes remain unchanged.

The machine had 14 logical CPUs and a one-minute load average rising from 18.9 to
26.6 near the interruption (versus 13.0–16.3 in the earlier successful loaded run).
That is uncontrolled ambient contention, not a matched A/B proof of causation.
The host event-loop peak around the failure was 75 ms; maximum worker/render/pipe
waits were 310/162/177 ms. Encoder backlog accumulated to 1.995 seconds before the
next check crossed the existing limit; queued source data peaked at 20.08 MB.
Whole-run CPU averages are misleading here because the encoder exits halfway
through the measured interval. Keep its resource samples and lifetime visible.

**Do not close heavy-load reliability.** The retained changes improve ordinary
performance and one loaded run, but do not guarantee sustained recording under
this heavier contention. Failure behavior passes: explicit interruption, correct
partial duration, independent preview/input and cleanup. Increasing the backlog
or silently changing resolution/CRF would conceal the limitation. The next design
work is a continuous encoded producer with verified hardware acceleration where
available, plus measured CPU-only capacity and an explicit overload policy. The
Linux component measurements inform that work; they do not fix the Mac path.

No further rate-chasing reruns or speculative encoder presets were applied. The
failed exact-source run is retained alongside the successful normal and loaded
runs in `docs/audits/2026-09-24/recording-efficiency/`.

## Linux prototype status

The reviewed pixelflux revision `40a9d46ba9b8c137b9812825041c68977ddf615f`
has a CPython 3.11 ARM64 wheel. Its downloaded SHA-256 matches GitHub's asset
digest: `a09a3b590c7317c2f96e9a945058f888761b4cf83a9611b5e3e436089a5e67d0`.
It is 24.03 MB compressed / 52.47 MB unpacked, including multiple codec libraries.
That is a prototype cost, not an addition to Mako's shipped dependencies.

The initial real Xvfb smoke captures the private 1920×1080 GTK fixture through
XShm and software x264. It does not use GPU acceleration, grab the Mac desktop,
enable pixelflux input/HTTP APIs, or establish web-viewer performance. The first
image lacked the GTK Cairo binding; that failed fixture is retained separately.
The existing recording image supplies it. No image was built or pulled.

The complete one-minute component and browser-viewer results, accuracy tradeoff
and upstream integration failures are in the [streaming comparison](local-control-streaming.md#september-24-isolated-prototype-measurements).
Capture reaches about 58.4 distinct fps; the viewers reach 54.6 WebSocket / 53.3
WebRTC. These are software ARM64/Xvfb measurements, not installed Mako, native
Moonlight, GPU or remote-network acceptance. No upstream stack is adopted.

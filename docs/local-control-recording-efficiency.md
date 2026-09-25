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

Two changes are being validated:

- Rasterize the cursor and press ring once into 7 KiB of immutable RGBA artwork.
  Previously every changed frame decoded SVG and encoded a PNG for composition.
  Fifty-six exact comparisons include clipping, scale and transparent native
  overlays. Four matched 240-frame encodes were byte-identical. Node rendering
  CPU fell about 9% in the small alternating comparison; throughput varied, so
  this is not a measured full-path speedup.
- Bound FFmpeg conversion to one filter thread and x264 to two encoding threads.
  Automatic pools retained about 770–821 MB in the matched experiment; two
  threads used 433 MB and reached 113 fps versus 97–100 for automatic pools.
  Those are encoder capacity tests with a repeated background and moving cursor,
  not distinct-source or viewer rates. Resolution, CRF 18, `fast` preset,
  frame history, output clock and interruption bounds are unchanged.

The two-thread encoder candidate is **rejected**: the full two-viewer/two-load-worker
run interrupted after 3.64 seconds and retained one verified playable second.
Its mean pipe wait grew to 21.5 ms/frame; small synthetic capacity tests did not
predict the real workload. x264's automatic encoder parallelism is restored;
conversion-thread isolation is being tested separately. The intended two-minute
fixture also needs an explicit recording limit above its measurement duration;
the script now reserves thirty seconds for its later verification/cleanup steps.

Threading changes compressed pixels: it is not a bit-identical optimization.
Six sampled frames compared against exact pre-encoder RGBA had at most 0.00025 dB
PSNR difference; the sampled dense-text region had identical error. The cursor
composition itself remains pixel-identical. Explicit screenshots never enter this
lossy recording path.

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

Next measurements: sustained capture/encode, decoded marker and text quality,
idle work and 4:2:0 versus 4:4:4, then the Selkies transport/viewer and available
Sunshine/Moonlight reference. Preserve component-only versus end-to-end evidence.

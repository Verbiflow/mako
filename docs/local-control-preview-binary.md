# Binary preview delivery

September 24, 2026. [Wayfinder LC-21](local-control-map.md#lc-21--responsive-capture-recordings-and-cursor)
owns this change. Implementation and focused tests are local; final production-decoder acceptance
and installed rollout remain open. Continuous recording is a separate change in
[the media investigation](local-control-media-investigation.md).

## Boundary and ownership

The agent API does not change. `BrowserCapture` still owns one screencast shared by
recording and visible previews. `ControlPreviews` authorizes the exact task target,
retains one latest frame and releases capture when watchers leave. Recording keeps
its own bounded timestamped history; preview transport cannot discard recording
samples or change input ownership.

The CDP source is decoded from base64 once; preview and recording share those
validated encoded bytes. Preview bytes remain `Uint8Array` from host retention through Electron
IPC and into the renderer. Explicit agent screenshots retain their existing image
contract. A Node client requests `application/vnd.mako.preview.v1` on the existing
private `/rpc` route. The web desk negotiates the same format through its existing
same-origin gateway. Both call the same registered preview handler, argument
validation and host-client context; this is not another session or capture server.

The packet has a 12-byte version/length prefix, at most 16 KiB of metadata and at
most 2 MiB of exact JPEG/PNG bytes. Readers enforce the total limit while receiving,
validate the prefix before allocation, copy each incoming chunk once and reject truncated packets. Tiny chunks cannot grow a retained buffer list. Oversized source images report preview failure; they are not silently reduced or shown as current. Capture and publication
timestamps remain distinct. Each host admits at most two outstanding media replies
per client and sixteen overall, with a five-second response deadline. An older
host/client pair receives an explicit compatibility error, not broken pixels or
an automatic agent restart.

Ordinary calls remain JSON. The former preview-only server compression path is
removed; the ordinary response reader still accepts bounded legacy Brotli replies
for host/client compatibility. Frames do not enter MCP results or model context.

The renderer owns one decode, one completed image awaiting paint, and one newest
pending source frame. Inspector and overlay share one decode of the same frame
within a renderer; the last consumer releases it. Decoding proceeds while a completed image waits for the
next animation frame. JPEG uses WebCodecs `ImageDecoder` after one capability query. Other formats and viewers without JPEG support keep HTML image decoding. Complete `VideoFrame`s match the covered HTML image pixel oracle; `createImageBitmap` did not. Superseded frames, decoders and Blob URLs are released, including late completions after disposal. Hidden preview and target-change cleanup retain
the existing task subscription behavior.

## Evidence and rejected experiments

- Focused tests cover exact bytes and timestamps, offset buffers, malformed and
  oversized packets, cancellation, target refusal, slow-client isolation, reply
  slot release, compatibility refusal and ordinary JSON calls.
- The initial sequential Blob URL decode/paint pipeline reached only 30.69 preview
  fps in a ten-second Aside trial; recording fell behind and failed. It is retained
  as a failed experiment.
- Direct `createImageBitmap` decoding produced 257,782 different channel values in
  the exact-pixel check. A separate 1600×1000 probe found 600,403 differing channels, each by one. This decoder was rejected. WebCodecs matched that same fixture exactly.
- Another run received 1920×686 source frames after initially receiving 1920×1080.
  Its fixed-size marker checks are invalid for that source change. A separate-window
  attempt began at 1920×686 too. A setup screenshot could reset the captured surface
  after the fixture's emulation override. The sustained fixture no longer takes that
  setup screenshot; the independent interleaved-screenshot regression stays intact.
- The clean ten-second run passed both 1920×1080 exact-pixel comparisons and all
  36 input checks. Preview reached 52.29 distinct fps, decoded video 56.20 fps; the
  longest repeated marker was 83.3 ms. These short, uncontrolled-load observations
  do not establish a performance improvement or sustained 60 fps.

## Acceptance and measured limits

The user explicitly accepts roughly 56 fps. Sixty remains the target. The sustained
fixture now uses 55 distinct fps as its minimum, checks full pixels and exact input,
and independently rejects preview/video freezes of half a second or longer. It
reports p50/p95/max gaps; crossing the minimum does not mean there are no dropped
frames or shorter hitches. Historical failed runs below retain their original verdict.

| One-minute Aside run, two viewers + recording | Preview / decoded video | Other evidence |
| --- | --- | --- |
| Shared HTML image decode, before final receiver change | 50.02 / 54.33 distinct fps | All 36 inputs and both full-pixel comparisons pass. Finished 67.4 s video; longest recorded hold 233.3 ms. 326 foreground samples unchanged. Misses even the revised floor. |
| Isolated WebCodecs candidate | 55.41 / 56.00 distinct fps | All 36 inputs and both full-pixel comparisons pass. Longest recorded hold 116.7 ms. Meets the revised rate floor; final production implementation still requires its own run. |
| Production decoder, two viewers, before RGB encoder input | 54.41 / 53.55 distinct fps | All 36 inputs and both pixel comparisons pass. Finished 68.65 s video, 150 ms longest recorded hold, 326 unchanged foreground samples. Below the revised floor. Click/type/scroll p95: 365/131/123 ms. |
| Production decoder, one viewer, before RGB encoder input | 50.96 preview fps; recording interrupted | All 36 inputs and the pixel comparison pass. Encoder lag exceeded two seconds after 34.88 s; independently verified partial output retains 31 s. This fails long-recording acceptance. |

The WebCodecs candidate used 12.87 MB/s binary response bodies with no base64
expansion across Electron IPC. Electron fixture CPU averaged 0.67 core and Node
host 1.01 cores. Those exclude the installed browser and FFmpeg. The previous HTML
run was 0.88/1.08 cores under different machine load; these observations do not
establish a statistical speedup. Total resource and installed-display accounting
remain open.

Regression checks pass for source sharing, slow clients, host shutdown/reconnect,
ordinary RPC, real same-origin web clients, decoder disposal and late output,
recording failures, and an isolated npm consumer of the public SDK. A fresh real
Electron fixture also passes five clipped screenshots during recording, fixed
1600×1000 source/output geometry and playback. No new package dependency or encoder
binary was added; the packed runtime is about 150 KB compressed / 614 KB unpacked,
excluding its dependencies and separately packaged native/media executables.

## Encoder follow-up

The failed single-viewer run remains recorded. An RGB24 experiment removed unused
alpha from the browser encoder pipe: 6,220,800 bytes/frame instead of 8,294,400 at
1080p. Every compared color channel matched, including letterboxing, cursor/ring
composition and clipped edges. Four matched 120-frame encodes produced byte-identical
MP4 files (SHA-256 `7c10c890b89508ebca29f95d29676c0ce527bb47aa2892c63a3c50928b936739`).

It was **not retained**. In an RGBA/RGB/RGB/RGBA comparison with the same moving
cursor, throughput was 90.57/86.82/78.10/81.79 fps. RGB pipe writes were shorter,
but stripping alpha after composition increased render time. The complete path
showed no clear improvement. Its separate loaded Aside run interrupted after
5.56 s, retaining a two-second playable prefix; preview averaged 40.22 fps. Both
full-pixel comparisons still passed. The production encoder remains RGBA with its
existing codec, CRF and bounded backlog. The experiment and failed run are retained
for review, not presented as a successful optimization.

A later diagnostic observed system load averages of 229.43/97.40/46.35, falling to
56.04/75.29/43.91 during follow-up checks. This does not prove the cause of the
preceding recording failure. The audit now records logical CPU count and system
load before, during and after each run. No unrelated process was stopped to improve
a score.

The acceptance fixture now counts actual binary payload bytes; serializing a
`Uint8Array` as JSON solely for measurement would reintroduce the overhead being
removed. The sustained run reports socket bytes and decoded/IPC payload bytes
separately. Raw JPEG delivery may use more wire bytes than Brotli-compressed base64
for repetitive fixtures, while avoiding the expanded JSON and compression work.

Remaining gates: final production one/two-viewer runs and installed-host acceptance. Existing tests cover concurrent input, exact pixels, reconnect and web-desk delivery; these do not replace installed acceptance. Complete process accounting still needs installed
browser/encoder CPU. Linux Selkies/pixelflux and Sunshine/Moonlight comparisons
follow this delivery change; no new streaming dependency has been adopted.

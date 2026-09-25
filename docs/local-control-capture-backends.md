# Native capture: reuse and acceptance

Reviewed 2026-09-24. This supports [LC-21](local-control-map.md#lc-21--responsive-capture-recordings-and-cursor).
The user-selected target is **1920×1080 at 60 distinct frames/s**, not 1440p or 4K.
The target applies to moving preview/recording content. Explicit screenshots keep
source detail and coordinate accuracy; a video budget must not change page layout.

## What exists and why it is slow

The shared driver currently uses ScreenCaptureKit on Mac, XComposite window
pixels through a CPU copy/FFmpeg pipe on X11, and a GNOME helper that repeatedly
returns PNG screenshots. GNOME then decodes those PNGs and re-encodes video. That
roughly 5 fps source is an interim implementation, not the intended live-video
backend. Raising encoded fps repeats frames; it does not fix capture.

The existing `portal_screencast.rs` is **not a reusable recorder as it stands**:
it requests Window **or Monitor**, caches one process-wide selection, and exits
after one frame. It cannot be substituted for a task-owned exact-window capture.
Its transport and buffer parsing may be reusable after ownership, selection,
continuous delivery and cleanup are replaced. The default Linux build does not
enable its optional `portal-capture` dependency group.

## Source-reviewed candidates

These are implementation comparisons, not Mako benchmarks. Revisions are pinned
so a later contributor can repeat the review. No new runtime dependency has been
adopted by this review.

| Project / revision | Useful implementation | Fit and decision |
| --- | --- | --- |
| [OBS PipeWire](https://github.com/obsproject/obs-studio/tree/bdf6dbe17cee9a1371add901e20359d9f0757159/plugins/linux-pipewire), `bdf6dbe` | Continuous PipeWire delivery, DMA-BUF formats/modifiers, texture import, recycling buffers and consuming the newest available frame; separate window selection through the portal. | Primary GNOME/KDE implementation reference. Reuse existing PipeWire/portal libraries behind Mako's session ownership. Do not bundle the OBS application. Repository license is GPL-2.0; preserve file-specific licensing for any adopted source. |
| [OBS XComposite](https://github.com/obsproject/obs-studio/blob/bdf6dbe17cee9a1371add901e20359d9f0757159/plugins/linux-capture/xcomposite-input.c), same revision | Names the target window pixmap and imports it as a graphics texture rather than repeatedly PNG-encoding the desktop. | Primary accelerated X11 reference. Prototype pixmap/texture-to-encoder delivery; retain a measured bounded CPU path for cloud machines without a GPU. Covered/minimized/destroyed windows must be tested separately. |
| [wl-screenrec](https://github.com/rosalyntg/wl-screenrec/tree/849e58497a8c88f236b1e1249358a274b18d6ffa), `849e584` | DMA-BUF capture, GPU conversion and VAAPI encoding; ext-image-copy-capture or wlr-screencopy. Apache-2.0. | Strong wlroots performance reference and optional isolated-desktop prototype. Its listed protocols and device constraints do not establish GNOME/KDE or exact-window parity. Published CPU numbers are its author's benchmark, not ours. Validate transformed outputs and no-GPU behavior. |
| [Selkies](https://github.com/selkies-project/selkies/tree/3a46db7d58e4bddf2dd1f031ee9577720545e8ab), `3a46db7` | Linux remote desktop delivery aimed at containers/cloud; browser client and GPU/CPU encoding, WebSocket delivery with optional WebRTC. MPL-2.0 repository; dependencies have separate licenses. | Best cloud-viewer comparison/prototype. An isolated job desktop can be its capture scope. It must not replace Mako's action engine, exact-window desktop contract, CLI, or authorization. Evaluate startup, image size and dependency cost before adoption. |
| [pixelflux](https://github.com/selkies-project/pixelflux/tree/40a9d46ba9b8c137b9812825041c68977ddf615f), `40a9d46` | Damage-aware capture/encoding; a bounded encoded Unix socket tap and a separate fragmented-MP4 recorder. The recorder's overflow, timestamp and reconfiguration behavior needs adaptation; X11 recording starts another encode. MPL-2.0 repository with separate codec dependencies. | First smaller-component experiment through a task-owned Python helper; the published crate is a PyO3 `cdylib`. Do not adopt its recorder unchanged. Portal code selects monitors, not exact windows. [Detailed findings](local-control-media-investigation.md#corrections-from-the-upstream-review). |
| [Sunshine PipeWire](https://github.com/LizardByte/Sunshine/blob/c48e50e418b27cba2b387c3a1ae9605da8a96341/src/platform/linux/pipewire.cpp), `c48e50e` | Mature low-latency capture implementation with buffer negotiation; the wider project supplies hardware/software streaming paths. GPL-3.0 repository. | Useful pacing, recovery and hardware-matrix reference. Not a drop-in task-owned window API or browser client; avoid introducing an entire second remote-control service by default. |
| [XCap Linux recording](https://github.com/nashaofu/xcap/blob/5c205f20cde2d5bdfcbc058db073cfd274a8eeda/src/linux/xorg_video_recorder.rs), `5c205f2` | Convenient Rust capture API, Apache-2.0. | **Not selected as the performance fix.** The reviewed X11 recorder calls `monitor.capture_image()` in a loop and sends into an unbounded channel; its recording constructor takes a monitor. That would retain the relevant polling/backlog and target-scope problems. |
| [obs-gnome-screencast](https://github.com/fzwoch/obs-gnome-screencast/tree/7034ee9cb4c5898878b8c2fd58bce7bbb8137e69), `7034ee9` | Older direct Mutter/GStreamer integration. GPL-2.0 repository. | **Do not adopt.** Archived; its README warns that GNOME restricts the private APIs and recommends OBS's portal/PipeWire path. |

Portal behavior is owned by the [ScreenCast specification](https://github.com/flatpak/xdg-desktop-portal/blob/main/data/org.freedesktop.portal.ScreenCast.xml).
Window selection is not a caller-supplied PID/window-id proof. Bind the granted
stream to its own capture target and verify any association with an action target;
never present an arbitrary selected stream as the requested app. Version 6 prefers
`pipewire-serial`/`PW_KEY_TARGET_OBJECT` because node IDs can be reused. Restore
tokens rotate and are single-use; revocation and session closure must invalidate
the grant. Request a hidden physical cursor and compose Mako's dispatched cursor
separately. A full job desktop is an explicit cloud scope, never a fallback from
window capture on the user's desktop.

## Implementation order and release gates

Current evidence: [native candidate results](local-control-native-capture-evidence.md)
and [sustained browser failure](local-control-preview-evidence.md#september-24-sustained-1080p-failure).
The browser's 60-second run stopped recording at 41.33 seconds after saving
536,971,545 bytes of JPEG frames. Its live viewer reached 52.02 distinct fps.
Encoding during finalization removed the earlier decoded-PNG staging failure,
but still accumulates source JPEGs during capture. Continuous encoding with a
bounded pending frame and recoverable partial output is required; increasing
the 512 MiB limit is not the performance fix. This work can proceed independently
of the Linux source replacement.

The [September 24 follow-up](local-control-media-investigation.md) tests recoverable
MP4 output using the already bundled encoder. Fragmented and hybrid output retain
a decoded prefix after SIGKILL; current `+faststart` does not. This is a container
experiment, not implemented continuous capture or a new 60-fps measurement.

1. **Finish source-rate plumbing.** Carry the requested fps through CLI/MCP,
   driver capability, capture source and output. Older fixed-rate drivers refuse
   unsupported requests before starting. Publish backend limits truthfully;
   GNOME remains limited until its source is replaced.
2. **Replace GNOME screenshot polling.** Prototype continuous PipeWire in the
   isolated GNOME fixture using existing Rust dependencies. Establish an exact
   window grant, source timestamps and geometry; keep one pending frame, recycle
   buffers promptly and stop on grant loss. Prove target isolation before adding
   GPU imports. Then run the same portal contract on KDE.
3. **Accelerate X11 and modern Wayland.** Compare the existing CPU source with
   XComposite texture import and ext-image-copy-capture/DMA-BUF. Enable accelerated
   paths only where format/modifier negotiation succeeds. Do not grant DRM master,
   whole-host display access or extra container privilege to pass a benchmark.
4. **Connect one media stream to preview and recording.** Keep encoded/binary
   media outside large JSON/base64 updates. Consumers share task ownership and
   bounded buffering; slow viewers cannot stall recording or accumulate history.
   Encode as frames arrive, retain source timestamps and cursor alignment, and
   finalize playable partial output after cancellation or interruption. Do not
   accumulate one source image file per frame for the entire recording.
   Use Selkies as a cloud comparison without changing the agent action contract.
5. **Accept exact artifacts per platform.** Run at least 60 seconds of moving
   1080p content, one viewer, two viewers plus recording, and concurrent actions.
   September 24 user decision: roughly 56 distinct fps is acceptable; keep 60 as the target. Use the shared audit’s 55 fps minimum and separate freeze checks, with
   measured gaps reported separately; always publish the actual rate. Report
   distinct frames, gaps, input-to-visible p50/p95, source/encoder/viewer
   CPU, memory, wire bytes and foreground changes. Keep software-only Linux in
   the matrix. Encoded 60 fps or a vendor benchmark is insufficient.

Every candidate must also pass: static-screen efficiency; covered target without
cover pixels; resize/scale/rotation; target closure and reused IDs; encoder crash;
slow consumer; cancellation during startup and shutdown; no orphan child/stream;
playable retained video after interruption; exact text/actions unchanged. Compare
small text and cursor legibility independently of frame rate. Record copied-code
licenses, target-specific installed bytes, startup and dependency versions with
the selected build. Do not pull all candidate projects into the shipped package.

Physical Mac IME/human typing and proactive focus protection remain separate
LC-24 tests. Capture projects do not establish input correctness.

For the client/transport choice, see [Moonlight, Selkies, KasmVNC and standard VNC](local-control-streaming.md#september-24-selection-browser-streaming-moonlight-and-vnc).
Moonlight is a native GameStream viewer, not a capture library or browser VNC
client. Standard VNC interoperability is a separate requirement from fast cloud
viewing; it must not force every internal frame through an RFB conversion.

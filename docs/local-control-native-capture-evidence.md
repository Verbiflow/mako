# Native source-rate evidence

Measured 2026-09-24. The tested +19 driver is now installed for new launches.
Capture measurements used the source runtime; the desktop-host rollout remains open.
The [wayfinder](local-control-map.md#lc-21--responsive-capture-recordings-and-cursor)
owns remaining work; [capture backends](local-control-capture-backends.md) records
the open-source comparison and replacement plan.

## Candidate and measurement

Driver `0.28.2+mako.19` uses base
`fc188250b4ca8549b8e61f937fdb1fb560770e86` and patch SHA-256
`e4ce26102114895bb3ebe23813015ee48d2b10c09dddf7ec353a1cedf5c04cf8`.
Mac ARM64, Linux ARM64 and Linux x64 artifacts were built. Native AMD functional
acceptance is recorded in [platform validation](local-control-native-validation.md);
it is not sustained 1080p evidence. Mac driver selection is now `+mako.19`.

Requested fps now reaches the capture backend and its acknowledgment. Mac and
X11 advertise a maximum of 60; GNOME's PNG source advertises 5. Old drivers
remain fixed at 30. Unsupported rates fail before recording starts. An output
file marked 60 fps does not establish a 60 fps source.

The Mac fixture draws a changing binary counter in an exact 1920×1080 window.
The test decodes that counter from `source.mp4`, before output frame duplication,
and samples the foreground application. It neither types nor activates the
fixture. Cursor composition is disabled in this source-rate test and has separate
recording coverage. The Linux fixture checks a covered 640×420 window, exact
Unicode writes, target pixels and interrupted-video retention. Its source-frame
count is not the Mac visual-counter distinct-frame measurement.

## Results, including failures

| Run | Source result | Acceptance and limits |
| --- | --- | --- |
| Mac `+18`, recording as the first operation | Driver aborted in `SCContentFilter` initialization before recording. | Reproduced a first-use failure. An earlier observation avoided it; capture must not depend on that workaround. |
| Mac `+18`, diagnostic pre-observation, 10 seconds | 570 distinct frames / 10.041667 s = 56.76 fps. | Foreground changed; not an unchanged-foreground pass. |
| Mac `+19`, first operation, 10 seconds | 577 distinct frames / 10.03 s = **57.53 fps**, 1920×1080. | Passed the short diagnostic and all 117 foreground samples stayed on Aside. Does not establish sustained acceptance. |
| Mac `+19`, first operation, 60 seconds | 3,404 frames, 3,400 distinct / 60.051667 s = **56.62 fps**, 1920×1080. | Below the 57 fps sustained floor. Foreground samples included Aside (341) and Mako (179). Sampling alone cannot attribute the change to human activity or another process; unchanged foreground was not established. |
| Mac `+19`, repeat, 30 seconds | 1,754 distinct / 30.536667 s = **57.44 fps**, 1920×1080. | Passed the 57 fps floor; all 331 foreground samples unchanged. |
| Mac `+19`, repeat, 60 seconds | 3,479 frames, 3,475 distinct / 60.59 s = **57.35 fps**, 1920×1080. | Passed the 57 fps floor; all 613 foreground samples unchanged. Exact 60 fps and physical input are not established. |
| Linux ARM64 X11 `+18` | 33 source frames / 2.366667 s = **13.94 fps**, 640×420. | The final file advertised 60 fps through duplicated output frames. Functional checks passed; source throughput was poor. |
| Linux ARM64 X11 `+19` | 138 source frames / 2.434 s = **56.70 fps**, 640×420. | Ten exact writes, covered-window pixels and playable interrupted recording passed. Short functional evidence only; no 1080p, distinct-marker or sustained claim. |

The Mac fix initializes the CoreGraphics display connection and validates window
geometry before creating the ScreenCaptureKit filter. The Linux improvement
replaces a 5 ms sleep on every full encoder-pipe write with a bounded wait for
writability. A single frame can fill that pipe many times, so the repeated sleeps
were limiting throughput independently of the requested capture rate. Write
deadlines and cancellation cleanup remain in place.

GNOME still uses screenshot polling. Neither these changes nor the final video's
frame-rate label makes that a continuous 60 fps backend. Proactive focus protection
and physical IME/concurrent human typing also remain separate open tests.

## Reproduction and artifacts

Use `scripts/test-native-capture-rate.mjs 60 60` under the permission-granted
Electron host. To select a candidate, set `MAKO_TEST_DRIVER` to its exact absolute
executable path; a missing candidate fails without fallback. Otherwise it uses
the installed selection. The CLI runtime is frozen before launch. Its default path records
as the first control operation. `MAKO_RATE_PREOBSERVE=1` is only a diagnostic
comparison. Each run writes its driver path/version, calls, source probe,
distinct-frame count, foreground samples and outcome to a private temporary
directory. Preserve failed runs too.

Linux uses `scripts/linux-control/start-recording.sh` and
`scripts/linux-control/recording-probe.mjs`, with `MAKO_RECORDING_FPS=60` and the
exact candidate mounted read-only. The acceptance container must include matching
Linux Sharp dependencies and FFmpeg; missing fixture dependencies are setup
failures, not capture results. Tests ran without container network access.

Machine-local JSON and media are under
`docs/audits/2026-09-24/native-source-rate/`: `mac-first-use-crash.json`,
`mac-preobserve.json`, `mac-short.json`, `mac-long.json`, `linux-arm64/` and
`linux-arm64-19/`. They are ignored and may be absent from a fresh clone. This
tracked summary and the executable fixtures preserve the method and outcome;
missing artifacts never count as a pass.

The repeat capture evidence, retained 60-second source video and gesture/cursor
recording are in `docs/audits/2026-09-24/local-control-native-parity/capture-dialog-continuation/`.
The separate gesture clip contains 862 frames over 14.89 seconds, 19 pointer
events and no dropped frames; it decodes and the cursor frame was inspected.
It covers click, right/middle/double-click and scroll, while background drag refuses.
The driver installation verified the signed package and records the prior selection
for rollback. Existing native daemons were not restarted.

# Local Control implementation history

Historical checkpoints, preserved from the wayfinder on 2026-09-23.
Read the [current wayfinder](local-control-map.md) for priorities and present status.
Statements such as “pending”, “installed” and “current” below describe the date
and build of their checkpoint; they are not current instructions or release claims.
Later evidence may supersede an earlier failure or open item. Original evidence,
limits and relative links are retained.

## 60 fps capture follow-up

2026-09-23: browser recording now defaults to 60 fps, and browser preview delivery
and native preview constraints target 60. The 30 fps browser default was a
conservative choice, not an established Chromium limit. Fixed timer drift and an
extra wait after asynchronous frame writes; one newest pending frame remains the
bound, with no backlog. No image-quality or resolution reduction was used.

A hidden dense 1600×1000 Electron fixture captured 315 distinct decoded frames in
5.33 seconds (~59 fps), with 59.8 preview updates/s and zero dropped frames. The
final run with five ordinary/raw clipped screenshots delivered 59.0 preview
updates/s, preserved frame geometry and stored 165 distinct frames across 3.04
seconds including capture pauses. A separate owned headless Chrome background
window delivered ~61 source frames/s at 3.8 ms median / 5.5 ms p95 browser-to-host.
These are host capture measurements, not installed-app click-to-visible latency.
See [capture evidence](audits/2026-09-23/local-control-capture21/README.md).

Native recordings still request 30 fps on Mac and X11. The GNOME exact-window
helper polls at 200 ms (~5 fps); a 30 fps encoded file cannot change that. Native
60 needs a rate-aware driver contract, ScreenCaptureKit/X11 source changes and a
streaming GNOME capture source, then real-frame and input-latency acceptance.
The preview's getUserMedia constraint does not upgrade the native recorder.

Remaining efficiency work is measurable: a dense preview can send ~555 KB of JSON
per frame, and the fixture consumed about 1.5 Electron CPU cores while capturing.
Replace full-frame/base64 transport only after comparing text fidelity, scrolling,
click-to-visible latency, CPU and bandwidth. Do not reduce screenshot accuracy to
make a frame-rate metric pass. Composable CLI verbs remain designed but unimplemented.

## Standalone service, shared capture and composable CLI investigation

2026-09-23 continuation: the standalone Node launcher/package now exists, without
Electron. Eleven lifecycle scenarios passed on ARM64 and native Intel x64 for the
initial package: complete jobs, concurrent isolation, EOF/interrupt/deadline,
backend/worker/launcher crashes, recording finalization and held-input cancellation.
The [runtime guide](local-control-runtime.md) contains configuration and target
build commands; [lifecycle evidence](audits/2026-09-23/local-control-standalone20/README.md)
records exact packages. Neither a public package nor the installed desktop app
was replaced. The native driver remains +mako.17.

The agent-experience investigation found independent preview polling, competing
capture operations, incorrect recording pixel metadata, a task-owner mismatch,
a silently ignored desk URL and undiscoverable element screenshots. The shared
stream/capture fixes, exact selector fields, locator screenshots, navigation-fault
handling and help changes are implemented locally. The native inspector now reuses
the overlay's video component and shares its capture lease.

The initial dense hidden Electron fixture delivered ~29.3 preview updates/s with
no JPEG re-encoding; the 60 fps follow-up above supersedes that cadence. Both
record fixed 1600×1000 pixels while regular and raw CDP clips run.
Recording sampling reduced unnecessary stored frames and retains the final frame.
The final ARM64 and native Intel x64 lifecycle packages pass all eleven scenarios
and whole-process-group cleanup checks. Installed Aside and full renderer presentation latency are
still unmeasured. Inactive headless tabs can supply no video; recording now refuses
that condition rather than announcing success. An explicit background window
works in the tested owned headless browser, without moving an existing tab.

CLI composability is a requirement: persistent task sessions, JSON stdout,
diagnostics on stderr, explicit files, useful exits, pipes and cancellation. The
[shell contract and engine boundary](local-control-cli.md) are documented; shell
`shot`/`record` verbs are not implemented. The service launcher still speaks MCP.
Replacing transport alone would not fix the capture or ownership bugs.

[Full investigation, measurements and remaining limits](audits/2026-09-23/local-control-capture21/README.md).

## Native x64 cloud acceptance, contributor CI and dev connection repair

2026-09-23 continuation: +mako.17 passes native Intel Xeon execution on a disposable
EC2 VM: thirty exact save jobs, 400/400 concurrent synthetic keystrokes, strict
identity/modal/read-cap checks, gestures, covered recording and interruption
retention. Median job time was 130.2 ms. The 87-frame recording has no reported
drops; a decoded cursor frame was inspected. The instance and its dedicated
network/key resources were removed after collection. This closes Intel native
execution evidence, not physical Mac IME, AMD or x64 Wayland coverage.

The reusable [contributor workflow](local-control-ci.md) uses GitHub-hosted
runners, pinned actions, read-only permissions and no cloud/provider credentials.
It is prepared locally, not published. A 56-file allowlisted payload avoids
uploading the checkout, `.git`, secrets, profiles or CLI credentials. Desktop
tests run without network as the caller UID/GID. Lockfile and desktop-startup
failures were fixed and retained; the final archive collected successfully.

`control.connectBrowser(id)` repairs a missing public connection operation.
Browser discovery/input remain side-effect-free with respect to connecting;
explicit connection does not invalidate unrelated native observations. The
reported dev PID had zero windows because its host was launched with `--web`,
not because the driver excludes itself. The exact dev desk now passes connection,
rendered screenshot and recording through the shared API. Existing MCP processes
need a fresh process to load this client change; no active provider was killed.
The running dev host’s Settings bridge was used to connect that exact dev browser
now, so its existing agent can open and capture it without restarting.

The [runtime design](local-control-runtime.md) separates Electron’s desktop/desk
adapter from the Node control service. The EC2 run contained no Electron. The
full Mako `--web` host still uses Electron, and a standalone cloud launcher/release
with complete crash/cancellation acceptance remains to be built. No new native
driver package was released. General proactive Mac focus protection and physical
IME/human typing remain open; the reference Linux executable is still unavailable.

Full lint passes (five existing React Compiler warnings, zero errors), along with
the control client, shared MCP, browser/desk and payload-boundary regressions.

Evidence, failures and exact hashes: [cloud/dev audit](audits/2026-09-23/local-control-native-x64-cloud19/README.md).

## Additional compositor acceptance and earlier Mac interception probes

2026-09-23 continuation: the existing +mako.17 package now passes twenty complete
background form/save jobs on Weston 13 and twenty on labwc 0.7.1 through the
shared host. Two apps use identical window and control names. Independent GTK
state proves exact Unicode values, one save per job, an untouched second app,
and unchanged focus-notification histories throughout all forty jobs. These are
native Wayland clients in isolated nested compositors on ARM64. Raw foreground
input and unverifiable window capture refuse; this does not add gesture or
exact-window capture support to those compositor families. Median three-action
job calls were 495 ms on Weston and 388 ms on labwc in the concurrent final run.
The repeatable test image is development-only; application bundles are unchanged.

Earlier Mac event-tap locations were tested against deliberate system activation.
HID/session taps saw no activation notification; the annotated tap dropped eleven
matching notifications after activation had already been observed. All three
trials allowed the scratch app to activate. This candidate is rejected, not
shipped as proactive protection. The human-input fixture now records activation
notifications too, so its check can catch interruptions between 20 ms samples.

No new driver release or active-host replacement occurred. General proactive Mac
prevention remains unresolved. Physical IME/human input and native Intel/AMD
execution still need the requested person/hardware; neither was synthesized or
claimed complete. Full lint and fixture compilation/syntax checks pass. See the
[continuation evidence](audits/2026-09-23/local-control-continuation18/README.md)
for versions, exact results, failed setup attempts and remaining limits.

## +mako.17: Mac focus recovery and correct gesture timing

2026-09-23: the signed Mac driver is installed for new launches. Existing daemons
and the running desktop host were not restarted. The shared host/client changes
are built and tested locally; this is not a replacement of the active Mako app.

Two Mac bugs are fixed. The no-overlay daemon now services the main run loop,
which NSWorkspace needs for notifications and fresh application state. Activation
notifications can also precede its cached frontmost PID update; restoration now
checks the actual WindowServer process identity. The deliberate system-activation
regression passes all three trials through the shared API: the fixture observes
activation and return to the original app, the receipt retains `focus_change`,
and a second action refuses until a fresh observation without replaying input.
The fixture's notification gaps are approximately 23–99 ms. This is reactive
recovery, not prevention of every visible interruption.

Intervening HID input-state activity disables restoration for that lease. No key
contents, event tap, screenshot or polling timer is added. These counters can
also include synthetic producers; neither the counters nor the unit tests prove
physical typing or all intentional human-switch behavior. Missing `focus_change`
is not a continuous-focus guarantee. The guard field concerns window topology.

The Wayland virtual-pointer route now honors requested drag duration, retaining
point spacing after delays instead of using a fixed eight milliseconds per point.
The old package delivered a requested 400 ms drag in 216 ms. Final +mako.17 Sway
acceptance passes normal scale, 150%, 150% plus 90° rotation, and two CPU workers
inside a two-CPU container. Delivered durations are 483, 436, 458 and 489 ms, with
13, 12, 15 and 19 received motion events. All four runs verify exact endpoints,
screenshot geometry/corner color and ten hidden Unicode jobs each (40 total).
This is not a guarantee that a compositor preserves every motion sample.

The final Mac background settling/input/recording suite passes; its 14-second
recording has 415 frames and zero reported drops, and an exported cursor frame
was inspected. Eleven focus-lease tests, five strict native result-contract tests,
the result-projection regression, control package and shared-host tests pass.
Full lint passes with five existing warnings and no errors. Mac ARM64 and Linux
ARM64 and Linux x64 packages match the reviewed patch and their provenance.
The x64 package passes thirty exact save jobs, 400/400 concurrent synthetic
keystrokes, gesture/cursor recording, covered capture and interruption retention
under translation. Both exported Mac and Linux cursor frames were inspected.
Two x64 attempts failed before driver startup because the readiness window stayed
unmapped. The query now runs off GTK's UI thread and the final suites pass, but a
separate slow-query comparison passed both versions: the original startup cause
remains unproven. The acceptance checks were not weakened.

General proactive focus prevention, physical IME/concurrent typing, more
compositor families and native Intel/AMD execution remain open. The physical-input
and hardware coordination questions remain unanswered. The reference Linux
executable is still unavailable. Retained failed candidates and final results:
[continuation audit](audits/2026-09-23/local-control-focus15/README.md).

## +mako.14 continuation: geometry fixes and measured Mac focus limits

2026-09-23: the 150% Sway probe reproduced wrong drag coordinates in +mako.13.
The new shared Wayland route reads `xdg-output` logical dimensions instead of
integer `wl_output` scale. Rotated screenshots exposed a second bug; native
screencopy now applies the output rotation/mirror before cropping, using lossless
pixel permutations. Final packaged acceptance passes in eleven Sway configurations: all eight
rotation/mirror transforms, normal 150% and 200%, and combined 150% + 90°.
Each checks exact drag endpoints, screenshot far-corner markers and ten hidden
text jobs (110 total). All eight orientation mappings have unit coverage.
+mako.14 is packaged for Mac ARM64, Linux ARM64 and Linux x64, and is selected
for new installed Mac launches. Existing daemons were not restarted. The signed
Mac package passes the background settling/recording suite. The x64 package
passes 30 jobs, 400/400 synthetic concurrent keystrokes, gesture/cursor recording,
covered video and interruption retention under translation. Native hardware
remains untested. A heavily loaded drag run failed continuity before the quieter
matrix passed; that stress limitation and fixture failures are retained.

Direct tests through the available Codex native API and Mako's shared MCP host
now separate two cases. Both keep the original app frontmost when a scratch
button calls `NSApp.activate`. Both fail when that button calls
`NSRunningApplication.current.activate`: the target becomes frontmost, and the
fixture's independent activation notification records it. Mako returned a
background dispatch receipt in the failing case. Neither passing API dispatch
nor reference symbol names establish general focus-steal prevention.

A separate active event-tap experiment dropped type-21/subtype-2 notifications
for the exact scratch PID; the app still took focus. This is a rejected
implementation, not shipped protection. The earlier process-notification
subtypes found in reference disassembly (16384/32768/61698) were not observed in
these live probes. Proactive system activation, human-switch discrimination and
cross-process dialogs remain unresolved.

A manual `local-control-linux-x64.yml` CI workflow checks the host CPU and Docker
architecture, reconstructs the pinned patch, packages the driver and retains
complete-job/gesture/recording evidence. It is prepared, not executed. Local
x64 builds still use translation. Physical Japanese IME and concurrent human
input still require a person; the coordination question is pending.

See [the continuation evidence](audits/2026-09-23/local-control-focus14/README.md)
for failed approaches, direct comparison fixtures and final package status.

## Previous +mako.13 acceptance

2026-09-23: Mac foreground drag and recording now pass against the signed
candidate. Exact key-window evidence fixes a refusal caused by a 66×20 transient
window above the real target. The fixture independently received all 22 events;
the recording retained 23 pointer samples, held the button through movement and
released it at the endpoint. An exported frame was checked visually. This does
not relax the refusal of background drag or prove proactive focus interception.

Sway acceptance passes at 1× and 2×: requested drag endpoints and scrolling,
exact screenshot dimensions plus a far-corner color marker, and ten hidden
Unicode writes while the other window retains compositor focus. The first 2×
run exposed half-distance pointer movement and a screenshot containing only half
the window. Input now maps physical output pixels to logical coordinates;
capture crops physical endpoints before resizing to the action coordinate frame.
Unknown multiple-output layouts refuse. Fractional scale, rotation and other
compositors are not covered by these results.

The host and native guard now accept foreground Wayland input only with fresh
exact PID/window evidence from Sway or GNOME helper 10. GNOME additionally checks
Overview, modal state and lock state: MetaWindow focus alone did not establish
input delivery. Its explicit activation route waits for Overview to close.
Libei's dedicated worker now carries the exact recording target and emits pointer
samples after dispatch, without relying on caller thread-local state. Final
GNOME gesture/recording acceptance passes, including absolute endpoints
after accounting for GTK client-side shadows. Both X11 routes now also retain
held-button state through drag motion.

Linux x64 passes 30 exact-value save jobs, all 400 tagged concurrent keystrokes,
stale/modal refusals, capped-value honesty, drag/scroll and covered recording
with interruption retention. Its 25 cursor samples include 21 held samples and
an explicit release. The x64 binary runs under translation; this is functional
acceptance, not native hardware performance.

The Linux package explicitly enables and checks `portal-input`; the previous
recipe omitted it despite source support. Final ARM64 builds and 632 core plus
455 Linux unit tests passed (five Linux tests remain ignored). x64 builds use a
separate Cargo cache and OrbStack's x86_64 translation on an ARM Mac, not native
Intel/AMD hardware. +mako.13 is signed and selected for new installed Mac launches
after the final
Mac runtime check. The installer preserved existing daemons and the running host;
rollback metadata is retained. Linux target checks use explicit packaged paths.

The physical-input fixture records only its scratch window's marked-text
composition, commits, keydown timing and focus. It requires exact final text,
completed background writes/saves and actual timing overlap. The earlier
15-minute participation wait expired with no input or background jobs; this is
not IME evidence. The fixture is now a registered AppKit application for proper
foreground identity. Reopen it when the person is ready to participate.

General proactive Mac focus interception remains unimplemented: the current
guard restores after activation. Reference symbols and disassembly identify
per-process mouse taps, a system-process notification tap and a ViewBridge
keyboard tap, but do not establish their filtering rules. The next implementation
must distinguish a tool-caused activation from an intentional human switch,
handle cross-process panels, release taps on cancellation and preserve keys
already in flight. Test with a scratch app that attempts activation, a save/open
panel and independently recorded physical typing; notification restoration alone
cannot satisfy the criterion. The reference Linux executable remains unavailable.

See the [acceptance report and counterexamples](audits/2026-09-22/local-control-acceptance13/README.md).
The final full lint run passes (five existing ESLint warnings, zero errors and
zero anti-slop findings); the concurrent terminal lint failure seen earlier was
resolved. Foreground-guard tests and host TypeScript compilation pass.

## Packaging cleanup and installed Aside acceptance

2026-09-22: the user confirmed retaining the patched Cua native driver. Browser
control is Mako-owned and does not require Cua. The obsolete npm Cua SDK,
experimental in-process adapter/selector and benchmark option are removed. The
shared MCP/native route remains. Automatic regular-profile remote-debugging
scanning is removed; explicit Electron, desk and cloud/test CDP routes remain.
See [packaging architecture, target matrix and open work](local-control-packaging.md).

Generated Python bytecode and media build directories are now ignored, with
source manifests/recipes retained. Builds prune orphaned host JavaScript; six
old compiled modules were found. The packager stages only target-specific Kiri
and media resources and audits the actual archive for wrong-platform packages,
stale SDK code, source maps and unexpected repository files. The first audit
caught 10,194,163 bytes of dependency maps despite the old staging exclusions.
Linux packaging now requires an explicit architecture and separates target caches.
The verified signed ARM64 app is 661,313,122 file bytes (630.7 MiB), down
65,677,597 bytes (62.6 MiB) from the prior signed control candidate. Both cold-start
routes, 700 resolved host imports, source/signature checks, ASAR extension setup
and packaged browser/native recording passed. Build and full lint pass (five
pre-existing React Compiler warnings; zero lint errors and anti-slop findings).
The Linux ARM64 executable was rechecked for version, ELF architecture and shared
libraries; no library was missing. x64 was not built in that audit; the +mako.13 follow-up above now has scoped
x64 functional acceptance.

The existing Aside Work extension was reloaded through its Extensions UI from
0.2.0 to 0.3.2, then the user's video/fullscreen was restored. Two installed-profile
runs completed 80 exact-value save jobs through public Local Control v2, including
scoped duplicate controls, confirmation dialogs, Unicode and unchanged Billing.
The second run also retained an interrupted recording on client disconnect,
refused stale handles before and after reconnect, and created/closed a fresh tab.
All 167 foreground samples in that run were Aside; physical human typing was not
measured. The first run sampled both Mako and Aside and makes no focus-continuity
claim. [Evidence](audits/2026-09-22/local-control-packaging/README.md).

The full installed desktop host has not been replaced while active. General
proactive native focus interception, physical IME/concurrent typing, touch/pinch and other untested
gesture routes, KDE/other compositors and native x64 hardware acceptance remain
open. The +mako.13 follow-up above establishes translated Linux x64 acceptance.
The physical-input coordination question remains unanswered; generated Unicode
is explicitly not counted as IME evidence. The reference Linux binary remains
unavailable. Packaging cleanup does not change these acceptance limits.


## Previous release: background accuracy (+mako.12)

2026-09-22: +mako.12 is signed, packaged and selected for new Mac driver launches.
Active daemons and the running Mako host were not restarted. The Linux ARM64
package includes GNOME helper v9. Source/binary/helper provenance and the complete
patch are retained. [Release report and evidence](audits/2026-09-22/local-control-next/release12/README.md).

Mac background raw clicks no longer defocus the user's process. Right-clicks no
longer double-dispatch, and middle-clicks now carry exact window routing. The
final signed-package job independently received 16 correctly counted gesture
events at the requested coordinates, matched all 19 recorded cursor samples, and
kept the same foreground app across 109 samples. Background drag still refuses.
A fixture bug (`clickCount` on scroll events) was reproduced and fixed; its
counterexample is retained. General app-initiated focus blocking is still open.

GNOME 46 exact-window screenshots now use the window texture, excluding covering
apps and overview transforms. Covered text updates and exact dimensions passed.
Window video shares the bounded X11 encoder; minimization returns a playable
partial recording and an explicit interruption. GNOME source capture is capped
at five frames per second. The final packaged GNOME and Sway jobs each passed ten
hidden/minimized Unicode writes while another window retained focus. The shared
X11 encoder/gesture job also passed. 375 Mac and 448 Linux unit tests passed.

Packaged browser setup's ASAR directory-copy failure is fixed and covered by a
real signed-archive regression, including repair on repeated setup. Regular-profile
extension 0.3.2 is now reloaded and has installed-profile acceptance above.
No remote-debugging fallback was introduced.
The old running host can still overwrite setup files until the full host is updated.

Still open: proactive blocking of arbitrary app focus theft; coordinated physical
IME/concurrent human typing; Mac foreground drag, MPX and Wayland gesture cursor
routes; KDE/other compositors, scaling and x64 coverage; and installed Aside/host
acceptance. The reference Linux executable remains unavailable. These results
support the tested routes, not a general claim of ChatGPT parity.

## Earlier +mako.11 implementation and acceptance

The user renewed authorization to finish native settling/focus protection, IME and
physical-input evidence, Wayland, gesture recordings, bundled media dependencies
and installed Aside acceptance. Native changes are in the existing driver checkout;
driver +mako.11 was selected before the +mako.12 release above. Existing driver daemons and the
running Mako app/extension remain unchanged. A new isolated signed host candidate
is prepared at `/private/tmp/mako-local-control-release/release/local-control-final/mac-arm64/Mako.app`.

Implemented: a bounded AXObserver subscription around native actions reports
process-notification quiet/deadline/unavailable separately from action success;
focus restoration rejects stale queued activations; recording scope now propagates
through drag/scroll workers and actual pointer dispatches. The first live fixture exposed dropped settling metadata in the core public
projection. The +mako.9 candidate makes this a typed optional result field. Its 631 core,
45 contract and 374 Mac unit tests pass. Live notifications passed (8 events),
but the strict locator exposed an unrelated AXIdentifier coverage bug. The
+mako.10 candidate fixes that optional-field accounting and adds Linux XTest
cursor dispatch capture. The +mako.11 candidate also guards against a starved
observer being mistaken for quiet. [Mac acceptance](audits/2026-09-22/local-control-completion/native-settling-final/README.md)
passed complete observation, typed settling, explicit final-value verification,
background scroll, cursor video and unchanged foreground. App timer batches
can exceed the quiet interval; the retained counterexample explains why quiet
must never imply completion. [Linux gesture acceptance](audits/2026-09-22/local-control-completion/linux-gestures10-focus/README.md)
passed actual-event/cursor coordinate matching, covered-window recording and
early-close video retention. Its gesture phase explicitly requests foreground
delivery inside an isolated desktop; background drag remains refused. See the
[native diagnosis](audits/2026-09-22/local-control-completion/native-settling-diagnosis/README.md). This does not yet provide busy-indicator detection,
proactive focus-steal prevention or native observation lineage.

Media binaries are built from pinned FFmpeg 8.0.1/x264 source with the existing
H.264 quality settings. The 23 MB bundle includes source and license artifacts;
`otool` reports system-only dynamic dependencies. Recording/cursor tests and
packaged-versus-development resolver checks pass. The isolated host passes
production build and full lint (five existing warnings); signed packaging and actual archive encoding with Homebrew excluded from PATH
also pass. [Clean-source packaged evidence](audits/2026-09-22/local-control-completion/bundled-media-clean-source/README.md) includes native cursor/alpha composition and decoded video.

[Native Wayland acceptance](audits/2026-09-22/local-control-completion/wayland/README.md)
now passes ten exact Unicode updates on a hidden Sway workspace while a second
window keeps compositor focus. Visible-window capture works. Hidden-window
capture and exact-window recording refuse explicitly; those remain real backend
gaps. This does not certify other compositors or physical user input. The initial
fixture failures are retained with the successful run.

Obsolete Rust debug caches from the earlier driver checkout were removed to restore
14 GB of disk space; source and release artifacts were preserved.
The user has been asked to coordinate the real physical-typing/IME fixture. An
actual reference Linux executable is still unavailable.

Final +mako.11 validation: 45 contract, 631 core and 376 Mac unit tests passed
(two existing ignores). Signed Mac/Linux packages retain source and binary
provenance. The final host passed build, lint, cold startup, quit/reopen and both
browser-frame/native-video encoding from app.asar with only bundled encoders.
The final Linux build repeated the Sway hidden-workspace job successfully. One
X11 run failed before recording with an empty window-manager client list; a
repeat passed. Setup now requires the WM to manage a real readiness window,
and [three fresh complete gesture/recording jobs](audits/2026-09-22/local-control-completion/linux-ready11/README.md)
passed. This improves the fixture's readiness gate; it does not prove the precise
cause of the earlier intermittent empty list. Logs and package receipts are in
[release11](audits/2026-09-22/local-control-completion/release11/README.md).

## Renderer import repair found during harness verification

2026-09-22: the [native-delivery recovery proof](audits/2026-09-22/native-delivery-validation/README.md) exposed browser loading of Node-only control code through `RecordingOptionsSchema`. The browser contract now imports the dedicated `@mako/control/control/recording` entry, and recording identity comparison uses typed target fields without `node:util`. Window/page/generation/lease and recording-ID mismatch tests pass. This preserves the recording API; it does not establish installed recording acceptance.

## Earlier observations and recordings implementation

2026-09-22: shared host/API changes are implemented in this checkout; native source
is `/private/tmp/mako-control-driver-platform`. Signed native release
`0.28.2+mako.7` is built for Mac ARM64 and Linux ARM64. The Mac launcher now selects
that version for new driver launches; existing daemons retain their executable.
The running Mako host and extension have not received this iteration. Preserve
concurrent provider/settings changes.

Implemented: scope/lineage/coverage-safe observation diffs with full-view fallback;
browser document lineage and navigation-during-read rejection; native screenshots
without implicit AX reads; native AX walk deadline/cancellation and passive nodes.
Core unit tests passed 630; Mac 371 with two existing ignores. Native lineage,
event-driven readiness/invalidation, and scoped native read acceleration remain
open. Native walk completeness/performance/cancellation need live acceptance.

The public API provides `await handle.record(options)`, `recording.stop()` and
`recording.status()`. MP4 and timeline paths stay outside model context. Shared
host/driver ownership, exact target identity, lost-start-receipt cleanup and bounded
capture are implemented. Browser frame streams bypass ordinary event history.
Native cursor evidence uses actual dispatch coordinates, excluding off-screen
activation primers. The newer candidate adds gesture dispatch hooks and the
acceptance listed above; untested routes remain open. Semantic actions
without mouse dispatch do not invent movement. Resize or target loss ends capture
explicitly. A finalized early-ending native video is retained with an interruption
reason. The new Mac ARM64 candidate bundles ffmpeg/ffprobe; Linux/development
hosts require runtime encoders. Audio is not implemented.

[Extension video evidence](audits/2026-09-22/local-control-completion/browser-recording/README.md)
and [longer runs](audits/2026-09-22/local-control-completion/browser-recording-long/README.md):
normal/2x cursor alignment, complete saved-form jobs, detach/reconnect/cancellation,
and active-recording restricted-frame interruption passed. The longer sample passed
300 baseline and 300 recorded server-confirmed saves. Recording retained 663 source
frames with one drop over 42.303 seconds. Sequential baseline/recorded runs cannot
establish a speedup. Extension 0.3.2 passed fresh-session checks; regular installed
Aside and physical concurrent typing are separate acceptance gates.

[Final Mac recording evidence](audits/2026-09-22/local-control-completion/mac-recording-final/README.md):
+mako.7 passed public API exact values, scoped forms, explicit screenshots and
unchanged foreground app. The normal 10.773-second MP4 and the 0.567-second video
retained after target closure both decoded successfully. Earlier cursor/early-close
failures are retained in historical evidence; this version fixes those paths.

[Linux video evidence](audits/2026-09-22/local-control-completion/linux-recording/README.md):
release +mako.7 passed exact Unicode values, covered-window capture and early-close
video retention through the public API. Four of five fresh release runs passed;
one failed before recording because both driver and window manager reported no
windows. After adding explicit X server/window-manager readiness, all five fresh jobs
passed in [repeated acceptance](audits/2026-09-22/local-control-completion/linux-desktop-ready-repeated/README.md).
The earlier failure is retained; passing repeats alone do not prove its cause.
No X11 finding establishes Wayland behavior or reference-Linux parity.

[Controlled reference Mac evidence](audits/2026-09-22/local-control-completion/reference-mac/README.md):
exact value-setting and Unicode paste; menu selection and panel cancellation;
reproducible Unicode loss through direct keyboard typing even after fixing the
fixture's missing Edit menu. The initial interval has 10,085 foreground samples
over 240 seconds without reference fixture activation. Physical human typing,
actual IME composition and cross-process panel input are still untested. The actual
reference Linux executable is absent; wrapper inspection cannot close that gap.

Release preparation uses `/private/tmp/mako-local-control-release`, an isolated
checkout containing Local Control changes. Production build and full lint passed
(0 errors, five existing warnings), as did recording and installer suites. Final signed packaging passed cold startup, real host/preload/composer, client
Quit/reopen and draft persistence checks. It includes the renderer import repair
and strict native recording startup identity checks. The [packaged encoder
check](audits/2026-09-22/local-control-completion/packaged-recording/README.md)
loaded Sharp and recording code from the actual app archive, encoded and decoded
video successfully. Read-only installation readiness reports active Mako/host
processes, so no running application was replaced. The versioned native installer
passed actual upgrade and repeat/ownership/failure tests. Media dependency packaging
and installed host/extension acceptance remain open.

Disk exhaustion during packaging stopped Docker. Cleaning this task's Rust debug
outputs restored space, Docker and the four previously running containers were
restarted, and affected Linux attempts are recorded as environment failures. The
independent five-run release series above was performed after recovery.

Remaining: event-driven native readiness and scoped reads; maintained focus,
menu/cross-process panel handling and clipboard-consumption transactions; controlled
IME and physical typing; Wayland runtime/capture; full native gesture cursor paths;
media packaging; host/extension deployment and regular Aside acceptance. No overall
parity or completion claim is made.

## Detailed reference evidence review

2026-09-22: reviewed `codex-cu-reference-evidence.md`, all six supporting files,
shipped reference JavaScript and current Mako native/host code.
[Corrections, comparison and reproducible probes](audits/2026-09-22/reference-evidence-review/README.md).

Mako already implements PID-targeted input, exact mouse-window targeting,
synthetic activation and Chromium accessibility enablement. The stronger remaining
leads are maintained focus protection (including menus and cross-process panels),
bounded complete native scopes and cancellable walks, event-driven readiness and
invalidation, compatible observation diffs, and clipboard-consumption transactions.
Current focus handling restores after activation; prevention throughout a complete
job still needs evidence. Mac tree completeness remains deliberately false.

A pure SDK probe reproduced an accuracy issue: diffing different scopes of the
same unchanged target reports false removals/additions. Target equality alone is
insufficient; scope, lineage and coverage compatibility need enforcement before
delta optimization. This review records the issue; it does not implement the fix.

The reference extension contains a foreign-extension-frame monitor that blanks
frames; its presence does not establish successful Aside interference prevention.
Its popup interceptor can also replace named top-level windows, and a substitute
parent handle does not alone establish the child's `window.opener` behavior.
Do not copy these semantics or generalize its narrow debugger-unattached retry
into replay after uncertain delivery.

Trace correction: 25/107 getApp-containing calls returned explicit errors, of which
22 were timeouts (23.4% errors versus 20.6% timeouts). These are sampled whole-REPL
calls, not native-action timings or a general task failure rate. Static symbols and
the partial caller graph do not prove unconditional settling or background-input
guarantees. Linux's 100 ms JavaScript delay does not establish native behavior.

Next evidence: matched Mac input/focus/menu/panel/IME jobs and actual Linux runtime
and isolation details. Current installation and regular Aside acceptance gates
below remain unchanged. No deployment or live input experiment occurred in this
review.

## Browser settings discovery and presentation repair

2026-09-22: the reported “Mako (this app) / Unnamed profile” row came from the
local DeskBrowser definition omitting `kind: desk`. Chrome was absent because
Settings listed live extension/debugging registrations, not installed browsers.
The old fixture supplied both browser profiles and never exercised that gap.

The desk definition is now classified at its source, and Settings accepts only
external extension browsers. macOS discovery checks installed web-handler bundles
for Chromium browser resources, excludes Electron packages (including renamed
frameworks), deduplicates canonical paths and includes the OS-default app outside
standard application folders. It is bounded, asynchronous and cached; it does not
open browsers, request debugging, or connect. Other platforms retain extension
registration discovery; this change does not claim Linux installed-app inventory.

Installed browsers remain selectable before connection. A saved application choice
resolves to a live profile only on an exact application match with one profile;
several profiles require an explicit choice. Closed saved profiles retain their
name without duplicating the installed app. The UI uses compact rows, actual app
icons, real profile names only, inline Aside instructions and a plain Computer use
permission row. Removed the generated avatar, unnamed-profile prompt, Manage
browsers section and unsigned-build copy. Icon bytes do not enter agent status.

Validation: installed-app, saved/default preference and desk tests passed; host and
renderer typechecks passed; full lint passed with the existing five React warnings.
Production component checks passed pointer/keyboard selection, setup without
connection, reduced motion, narrow/light/dark layouts, and actual installed browser
metadata/icons. The live Mac scan found Aside and Google Chrome in about 162 ms;
Mako and ChatGPT were excluded. Screenshots and discovery evidence are in
[audit evidence](audits/2026-09-22/browser-settings-repair/README.md).
These are source and isolated-renderer results; the installed app has not received
this repair. The prior failed installer remains a separate release gate below.

## Linux implementation and durable browser recovery

2026-09-22: source work is in `/Users/kashyab/mako-control-rollout`; native source
is `/private/tmp/mako-control-driver-platform` on the pinned upstream base.
[Implementation and evidence](audits/2026-09-22/linux-control-implementation/README.md).

Implemented: exact Linux values and walk coverage; passive scope containers;
canonical roles and input state; retained accessibility objects for semantic
click/replacement; modal and destroyed-object refusals; no uncertain insertion or
pixel fallback; X11 focus attestation before host and driver input dispatch.
Linux help no longer advertises unverified background pointer/keyboard routes.
A late raw-driver focus check was caught by a negative test and moved before all
foreground input routes in candidate `0.28.2+mako.3`.

The candidate passed 30 GTK fill → exact read-back → Save jobs through public MCP,
all 400 uniquely tagged keys in the other window (385 during the final job loop), reordered and
destroyed controls, modal parent refusal, bounded walks, oversized value proof
refusal and text-only reads without screenshots. The host and raw driver both
refused foreground input to the background target. Release `+mako.3` packaging and its final
release-binary rerun passed; complete-job median/p95 were 128/140 ms. Linux units: 448 passed/5 ignored; common
contract: 45 passed; Mac native units: 368 passed/2 ignored. These are isolated
ARM64 X11 results; Wayland and x64 are not certified by them.

Extension 0.3.1 passed 12 complete saved workflows on each of macOS and Linux
Chromium, then forced-reload recovery on both. Reload preserved the page and
value, kept durable interruption evidence, rejected the old lease and allowed
fresh inspection without replay. Recovery never treats reused tab IDs as a
browser-incarnation proof. A popup notice makes interruptions visible. Claimed
parents now own their child tabs, and Linux identifies the real browser process.

The previous signed app handoff **failed** on orphaned crashpad processes 76176
and 76183. The installer now verifies and reaps that exact orphaned executable
after authorized host exit. Tests preserve unrelated, parented and changed
processes. The implementation is integrated into main at `7b6fc7e`. Signed app
`f3562d64e9ea18dc` contains extension 0.3.1 and the updated host/installer; packaged
bytes and its signature were verified. The queued handoff subsequently ran and
**failed verification**: after stopping the idle browser helper, the replacement
host reported old build `1f2c6af3acd5149e`, not expected `f3562d64e9ea18dc`.
The receipt does not establish why replacement failed; installation needs further
investigation. See the [live installation receipt](audits/2026-09-22/linux-control-implementation/installation.json)
and [signed build receipt](audits/2026-09-22/linux-control-implementation/signed-app.json).
The last verified host is `1f2c6af3acd5149e`; the installed Mac driver remains
`+mako.1`. The Linux ARM64 `+mako.3` release is packaged separately. Regular Aside
extension upgrade and controlled typing, native popup focus, Wayland, Linux x64
and wider app coverage remain open. No ChatGPT parity claim is made.

## Reference evidence still worth obtaining

The user offered additional reference details. Highest value: action traces or
implementation details behind native Mac/Linux input (exact target, focus,
clipboard, text composition and fallback); capture/readiness rules with timings;
full task tool inputs/outputs and observation sizes; popup/foreign-extension and
restart failure traces; and the actual Linux desktop/compositor and job-isolation
configuration. Record product/build, OS/backend, app/browser version and transport
for each. Prefer reproducible saved outcomes over demonstrations of cursor motion.
The installed JavaScript SDK, extension bundle and report have already been read;
additional wrapper inventories do not answer native-service behavior.

Mako's remaining work includes installed regular-profile acceptance; Electron/Qt,
rich editors, text selection/paste, named accessibility actions and cancellable
drags; event-based bounded readiness and measured scoped/incremental reads;
arbitrary page-triggered download completion; Linux x64/Wayland and production
job isolation; and repeated matched workflows across models/providers. Compare
verified completion, incorrect mutations, user interference, refusals, model
round trips, context volume and p95 job time. Existing passing fixtures do not
prove better end-to-end model performance or universal background support.

## Mac/Linux accuracy and background audit

Historical audit; the implementation and current release status are recorded above.

2026-09-22: [comparison and implementation order](public-audits/2026-09-22/native-platform-comparison/README.md)
checks the supplied Layers 3–4 report against installed reference SDK/docs and
Mako's pinned native source. Keep accuracy as a release constraint and measure
performance per independently verified complete job.

Four source-derived protocol probes reproduced Linux incompatibilities without
sending input: strict locators always refuse the driver's incomplete trees;
exact editable-value proof is missing; the foreground guard requires an app flag
Linux always returns false; native capability help asserts background routes
without backend evidence. These are not Linux GUI test results. Mac acceptance
and the previous native 995/995 typing result do not establish Linux/browser parity.

Priorities: driver-owned platform/focus/value/scope contracts; a reproducible
isolated Linux desktop and packaged runtime; durable ownership/action recovery;
broader child-tab attribution; then measured readiness/API improvements.
For shared Mac/regular-profile browsers, preserve real popup semantics by default.
The reference's popup interception sometimes returns a substitute window object;
copying it universally would trade website correctness for background behavior.
Cloud Linux should isolate desktops per job so popup focus stays within the job.
These are audited next steps, not implemented or deployed changes.

## Extension workflow validation and release

Historical 0.3.0 release record. Candidate `89c04a9f9814da4b` is superseded by
`f3562d64e9ea18dc` above; disposable-profile forced reload is now proven on both
platforms. Regular Aside upgrade and concurrent typing remain unproven.

2026-09-22: implementation is in `/Users/kashyab/mako-control-rollout`.
The public API now has strict semantic locators and target-specific capabilities;
help can return one topic. Locators resolve fresh refs and dispatch once. The
public native/page integration test passed a repeated-label form using the new
locators with independent submitted-value checks and unchanged foreground.

Extension 0.3.0 adds action-driven isolated cursor feedback, named task groups,
retained results, exact child-tab attribution, owned audio cleanup, protocol
matching, worker ownership recovery and idle update gating. Real Chromium tests
caught a grouping-window bug (fixed by explicit window ID) and confirmed the old
Page download command is unavailable through the extension. URL downloads now
use the browser's own download IDs and can be checked without restarting. A
popup → download → retained-result workflow passed two browser restart rounds.
Ref-triggered arbitrary page downloads remain unsupported through the extension.
Added permissions are tabGroups and downloads; cursor feedback uses existing
debugger access, without blanket website scripting permission.

Final shared-client, extension, native/page public API and lint checks passed.
Two real Chromium rounds completed popup → download → retained-result jobs,
plus restart, detach, canceled dialogs and no-replay checks. Hidden-tab benchmark
medians were about 3 ms for reads and 8–9 ms for typing. Tail latency varied;
read p95 increased. This is no general speedup claim. Hidden cursor feedback sent
zero commands for 10,000 calls; visible bursts coalesced to six commands.

Implementation is committed as `01360d6` and integrated into main as `df9129b`.
Signed candidate `89c04a9f9814da4b` passed packaged-byte and signature checks and
is queued through the idle installer, replacing the older candidate. Its receipt
is `~/.mako/browser-host-releases/5e421f03704df6b1/workflow-install-handoff.json`.
The installed app/regular Aside extension are still older.
Installation waits for active work to finish. Positive unpacked-reload proof and
controlled browser concurrent typing remain open. See the
[workflow evidence](public-audits/2026-09-22/extension-workflows/README.md) for the exact
measurements, permission changes and limitations.

## Broader extension design audit

2026-09-22: audited the user-supplied `chrome-chatgpt.md` beyond detachment.
Its normalized background matches installed ChatGPT extension 1.26.901.11451;
the matching installed cursor content script and asset were also inspected.
The [design audit](audits/2026-09-22/chatgpt-extension-design/README.md) covers
cursor motion and visibility, tab grouping/favicons, semantic locators, collection
reads, capability help, action results, child tabs/popups, audio, downloads,
reconnect, mixed versions, idle updates, worker restart and handoff.

The main gaps are visible task ownership, easier semantic targeting and
instance-specific capability/help, plus explicit update/recovery contracts.
Preserve Mako's bound targets, scoped compact observations, exact values and
no uncertain replay. Drive cursor UI from shared host activity for every harness;
do not require extra model calls or animation waits for hidden work. No new cursor
or locator API is claimed as shipped. The audit gives concrete design criteria
and an implementation order.

A disposable localhost-only foreign-frame observer experiment still detached
even after verifying installation. It does not prove the full reference fails,
but it rules out calling a simple observer a demonstrated fix. The new code was
not installed in the user's extension or regular profile.

## Extension rollout checkpoint

2026-09-22: extension 0.2.0 and the versioned Native Messaging helper are live in
the regular Aside Work profile. The helper reconnected automatically after its
idle restart; the stale checkout launch path is gone. Production changes are
integrated in the main checkout through `e15f439`.

The signed full Mako build `5e421f03704df6b1` is queued through the existing
idle-time installer. The running app still reports `1f2c6af3acd5149e`; active
sessions must finish before replacement. No completed installation is claimed.
The old installed updater cannot stop a surviving browser helper; a bounded,
one-time handoff is armed to clean up only the idle registered helper after the
original host exits, then verify the new build. It never stops active work.
Its receipt is linked in the rollout record.

Three regular-profile extension jobs passed 24 saves each (72 total), including
cancelled/accepted confirmations, screenshots and cleanup. The last ran with the
final helper and recorded switches among Aside, Ghostty and Mako. Aside and Chrome
for Testing also passed browser restart, foreign-frame detach cleanup, client
reconnect, stale-handle refusal and task/persistent tab lifetime separation.
Chrome for Testing additionally passed cancellation with no uncertain-action
replay. Default-browser matching uses the actual registered application identity,
not a Chromium-brand allowlist; saved and explicitly cleared choices are respected.
The final signed host passed a first-run RPC check against the actual OS default:
it saved Aside · Work and left the browser disconnected.

The controlled browser typing check FAILED after 28 tagged keys because Aside
became foreground. Its cause is unresolved; the 995/995 native typing result does
not cover this browser test. Action-level focus tracing is ready for a quiet
interval. Installed-host verification and stable Chrome regular-profile coverage
also remain. Manual Aside overlays and foreign privileged frames remain browser
restrictions, with explicit interruption and cleanup handling rather than direct
fallback. See the [extension rollout evidence](audits/2026-09-22/extension-rollout/README.md).


Latest design revision: browser Settings now uses compact rows with actual icons
and readable profile names. The idle connection dot/Disconnect toolbar is gone;
readiness is plain text, access maintenance and direct debugging share one Manage browsers disclosure.
Aside’s own row expands to show its setup instructions; selection and expansion
have separate keyboard-accessible controls within one continuous selected row;
the chevron has no detached button fill. Colors reuse Mako’s warm neutral tokens. The existing
libraries.dev Thinking Orb mounts only while connecting; reduced-motion renders
a static frame. Pointer/keyboard, access enable/disable, idle unmount, reduced
motion, light/dark and narrow checks passed. See
[browser Settings acceptance](audits/2026-09-22/browser-settings/README.md).

Current checkpoint: Aside’s automatic text-selection popup is disabled with user
authorization. Its regular-profile Mako extension passed two complete six-save
jobs afterward, including dialogs, screenshots and cleanup, without direct
remote-debugging sessions. The new Settings browser picker saves one preferred
external profile for all providers. Public `openTab({url})` uses that choice;
explicit browser IDs override it and unavailable profiles never silently fall
back. Setup guidance and event-based interruption reports require no recurring
browser probes. See [browser Settings acceptance](audits/2026-09-22/browser-settings/README.md).

The Aside setting is live. The Settings UI and host changes are implemented and
locally tested, but not installed as a full Mako app update. Native foreground
acceptance passed 995/995 tagged keys; public native Command restrictions remain.
Older pending-user-answer and separate-profile checkpoints below are historical.
The user wants the regular profile; Chrome remains an option if Aside becomes
incompatible, not an automatic fallback or a change to the OS default browser.

Updated 2026-09-22. Status: public API replacement, caller migration and focused
acceptance complete. D1 and D2 are implemented. The existing Electron native
accessibility lane remains intermittently unreliable; see the acceptance record.
The follow-up below records implemented typing, scoped-read and capture fixes,
with remaining driver and broader task-evaluation limits.
No packaged release or comparative Codex performance claim is implied.
The September 22 background comparison reopens native exact-value assurance and
records a native Command-chord gap plus repeated external-browser detachment.
See the [comparison audit](audits/2026-09-22/background-control-comparison/README.md).

## Destination

Refactor Mako Local Control into a coherent browser and native-app programming
API with persistent target handles, deliberate observation/output, accurate
execution evidence, and less repeated context. Preserve one provider-neutral
`mako-control` server, exact ownership, foreground controls, and recoverable
oversized output.

This map owns Local Control progress. The [meta-harness map](meta-harness-map.md)
owns provider/runtime work; the [remote-control map](remote-control-map.md) owns
remote channels. Neither is a Local Control implementation ledger.

Writer: current Local Control refactor conversation, working in
`/Users/kashyab/makomono/mako`. Existing unrelated changes are present. Keep
changes scoped and inspect overlapping edits before migrating consumers.

## Evidence and its limits

The supplied comparison bundle contains one historical turn, newest first,
with thirteen sidecars. Some original tool outputs themselves contain
truncation notices or explicit source slices; the bundle's lossless packaging
does not recover that missing content. Historical requests are context.

The historical comparison inspected Codex's bound App/Tab API, explicit
observations, emission suppression, diffs and persistent JavaScript. It did
not run a matched Mako-versus-Codex benchmark. These are design references,
not proof of comparative speed or reliability.

Current source inspected:

- [Host control implementation](../electron/computer-tools-main.ts): routing,
  ref validation, observations, receipts and MCP help/catalogue.
- [Control contract](../packages/control/src/control/contract.ts) and
  [receipt contract](../packages/control/src/computer/control-contract.ts).
- [Worker](../packages/control/src/program/worker.ts) and
  [runtime](../packages/control/src/program/runtime.ts): per-cell APIs, output,
  cancellation, persistent state and cell resumption.
- [Bound client](../packages/control/src/control/client.ts),
  [structured selection](../packages/control/src/browser/observation.ts),
  [browser observation](../electron/browser-observation.ts) and
  [browser service](../electron/browser-service.ts).
- Historical measurements: [runtime baseline](audits/2026-09-14/control-runtime-baseline.md)
  and [background audit](audits/2026-09-14/background-control-audit.md).

## Baseline findings (before refactor)

1. `control.act()` combines routing, dispatch, post-action observation, polling,
   verification, delta construction and topology guards in the host. Returning
   the whole result duplicates changed content in the observation and delta.
2. Verification searches rendered lines for expected text, or treats a changed
   observation as confirmation. Another field can contain the expected value;
   a Save error is also a screen change. Compact values are abbreviated at 80
   characters, so those strings cannot prove exact long-value equality. Empty
   values are omitted by the compact projection. Assertions need structured,
   target-specific evidence and must distinguish absence from incomplete reads.
3. `state` survives ordinary cell errors, but top-level local declarations do
   not persist. API closures capture a cell's `active` flag and `runId`;
   persisting a bound object made from those closures would address an ended
   cell. Persistent handles require a runtime change, not method aliases alone.
4. Page helpers observe through `advanced`, whereas unified observations also
   populate host `controlViews`/`controlRefs`. These paths need one authoritative
   observation/ref lifecycle before callers can freely compose them.
5. `exec` embeds `controlHelp()` in its catalogue description, including native
   tool names. Tool enumeration and runtime creation also request driver tools.
   Separate browser-only readiness from native startup, and measure a smaller
   bootstrap with help disclosed when needed.
6. Exact page leases/generations, cancellation uncertainty, native snapshot
   refs, action-scoped browser focus emulation, artifact spill and bounded
   polling are existing mechanisms to preserve. Documentation still contains
   contradictory historical token-carrying prose; reconcile it with the tested
   final contract during migration.

## Grilling decisions

| ID | Choice | Recommendation and trade-off | Status |
| --- | --- | --- | --- |
| LC-D1 | Replace the public `control.act`/`page` API or keep both? | Replace after migrating callers. One documented object API costs less context and maintenance; old scripts require migration. Host intent/routing contracts can remain internal. | Accepted 2026-09-22 |
| LC-D2 | Explicit observation or automatic post-action observation? | Actions return small execution receipts; programs explicitly observe/assert. This permits batching and avoids redundant trees, but verification must be explicit. | Accepted 2026-09-22 |

User decision: “Yes replace the old public API, no stale shit please. Yes sure
we can make observations explicit, as long as this is better design.”

Implementation choices within that direction: persistent bound handles in
`state`, retaining the existing async-body execution contract; explicit app
windows rather than implicit first-window selection; compact observations by
default and structured nodes available locally. Lexical REPL persistence,
annotations, managed browser profiles and platform expansion are outside this
API refactor. No additional user decision is currently blocking implementation.

## Delivery and completion gates

| Ticket | Work | Dependencies | Completion evidence | Status |
| --- | --- | --- | --- | --- |
| LC-01 | Baseline and caller inventory | None | Current contract, runtime and MCP regression results; retained context/latency baseline; migration consumers identified | Complete |
| LC-02 | Public API and module boundaries | D1, D2 | One typed contract with examples for browser, native window, screenshots, events and failures; explicit unsupported capabilities and exact-window selection | Complete — [API reference](local-control-api.md) |
| LC-03 | Persistent handles and cell lifecycle | LC-02 | Handle works across successful cells and ordinary errors; cancellation/reset invalidates it; late calls cannot borrow a newer run's authority | Complete — evidence below |
| LC-04 | Observation, refs and output | LC-02 | Structured reads and selection; deliberate text/image emission; full/diff recovery and completeness metadata; no duplicate output or action-capable stale refs | Complete — evidence below |
| LC-05 | Dispatch and assertions | LC-02, LC-04 | Separate dispatch/unknown/not-dispatched evidence from postconditions; wrong-field, duplicate-name, long/empty-value, validation-error and incomplete-read cases cannot falsely confirm | Complete — evidence below |
| LC-06 | Migration and help | LC-03, LC-04, LC-05 | Runtime, host, current scripts, fixtures, benchmarks and instructions use the selected API; old paths retired according to D1; browser-only startup works without native driver | Complete — evidence below |
| LC-07 | Real workflows and measured acceptance | LC-06 | Native and page fixtures pass independently; foreground unchanged where promised; matched before/after measurements and provider transport checks retained | Complete — evidence below |

The internal split should put typed handles, observation selection, output
projection and assertion composition in `@mako/control`. The host retains
ownership, dispatch validation, routing, driver sessions and uncertainty.
MCP registration exposes the same contract to every provider. Keep one owner
for each fact; avoid a second planner or a second cache with different ref rules.

The initial caller search found executable programs in
`scripts/test-local-control-e2e.mjs`, `scripts/test-computer-tools.ts`,
`scripts/benchmark-control-agents.ts`, `scripts/benchmark-control-runtime.ts`,
`scripts/provider-e2e-browser.mjs`, `scripts/test-desktop-continuity.mjs` and
`scripts/test-rewind-e2e.mjs`. MCP name/config consumers include
`electron/live-actions.ts`, `electron/live-conversations.ts`,
`electron/live-transfers.ts`, `scripts/test-mcp-entry.ts` and
`scripts/test-devin-permissions.ts`. Name-only references may need no change.
Repeat the caller search before retirement; this list is an initial inventory.

Acceptance measures completion and false confirmations before context savings.
Record catalogue/instruction bytes, returned text/image bytes, host reads and
mutations, tool time and wall time separately. Model runs additionally record
total input tokens, peak context, cached input when reported, turns and repeated
actions. Compare the same tasks with independent final-state oracles; synthetic
serialization timings do not certify native speed. A Codex comparison requires
matched model/tasks/budgets and remains separate from Mako before/after tests.

## Progress log

- 2026-09-21: read supplied comparison and sidecars; checked current ownership,
  observation, receipt, worker and help implementations. Located existing
  wayfinders; created this dedicated Local Control ledger.
- 2026-09-21: `npm test --prefix packages/control` passed all nine suites.
- 2026-09-21: `tsx scripts/test-computer-tools.ts` passed current native-adapter
  and unified-control fixtures. This does not establish live native behavior.
- 2026-09-21: `tsx scripts/test-browser-runtime.ts` passed state, cancellation,
  resumable-cell, output and artifact regressions.
- 2026-09-21: first interview round asks D1 and D2. Answers are pending;
  recommendations are not recorded as accepted decisions.
- 2026-09-21: twenty-run transport microbenchmark completed. Retained
  [raw baseline](audits/2026-09-21/local-control-refactor/runtime-baseline.json).
  Unified fixture catalogue/instructions: 5,198/3,472 bytes (native fixture),
  5,141/3,472 bytes (page fixture). Structured page selection: 32,248 → 208
  returned bytes. Oversized output spilled successfully in every lane.
  Timings are fixture serialization/transport readings; no model or live UI
  ran. Artifact paths inside the JSON are the original temporary locations.

- 2026-09-22: recorded D1/D2 acceptance. Added bound app/window/tab clients,
  explicit structured observations, compact serialization, multiset diffs and
  exact-value assertions. Replaced host act/read-back logic with dispatch
  receipts; no screen-change confirmation or automatic retry remains there.
- 2026-09-22: worker uses async-local cell ownership so handles survive ordinary
  cell boundaries but callbacks from finished cells cannot borrow a newer run.
  Removed the public page helper and migrated unified MCP/e2e/benchmark callers.
- 2026-09-22: coordinate actions require the latest capture token. High-level
  mutations retire refs before dispatch, and uncertain outcomes require a new
  observation. Raw calls invalidate unified refs; browser-only programs and
  basic help no longer initialize the native tool catalogue.
- 2026-09-22: pure package including new assertion/ambiguity/empty/long-value,
  partial-observation and diff cases passes. Host/runtime/browser regressions
  and live fixture acceptance are still being run.

## Acceptance record

The replacement is implemented and the current source callers have migrated.
The old public worker methods and page helper export are absent; the legacy
browser helper module is deleted. Private native/browser regression adapters
remain intentionally separate from the managed provider API. Historical audit
transcripts retain their original API calls as evidence, not current guidance.

- `npm test --prefix packages/control`: all ten suites pass, including exact
  empty/long values, wrong-field and duplicate matches, incomplete reads,
  no assertion replay, compact observations/selections and ref-independent diffs.
- Electron TypeScript build passes. Focused ESLint and oxlint checks pass.
- `npm run test:mcp`: all fifteen scripts pass. This includes provider transport
  registration, runtime lifecycle, lease/generation ownership, cancellation,
  native and page routing, previews and foreground guards. New host tests prove
  one explicit read with no automatic post-action read, expired refs/views,
  preserved fault codes/outcomes, uncertain-write recovery without replay, and
  browser execution/status/help with an unusable native driver executable.
- `node scripts/test-control-api-e2e.mjs`: live Cocoa native and Electron page
  workflows pass. Independent fixture files confirm input and submitted values;
  screenshots retain view tokens; handles work across cells; the frontmost app
  remains unchanged. [Retained live evidence](audits/2026-09-21/local-control-refactor/public-api-live.json).
  This uses the installed driver and checkout host, not a signed packaged release.
- The older `test-local-control-e2e.mjs` initially passed, then two reruns failed
  on Electron accessibility writes in its private driver-helper lane, before
  reaching public API assertions. Those failures were not converted into passes
  or hidden behind retries. [Retained legacy outcomes](audits/2026-09-21/local-control-refactor/legacy-live-results.json).
  Prefer the available page route for Electron forms; native Cocoa acceptance
  passed. Consistent Electron AX write delivery remains a driver/backend issue.

Twenty-run fixture measurements are retained in
[runtime-after.json](audits/2026-09-21/local-control-refactor/runtime-after.json)
alongside the baseline:

| Measure | Before | After |
| --- | ---: | ---: |
| Unified native catalogue | 5,198 B | 2,111 B |
| Unified page catalogue | 5,141 B | 2,111 B |
| Bootstrap instructions | 3,472 B | 1,609 B |
| Native catalogue + instructions | 8,670 B | 3,720 B (57.1% less) |
| Page catalogue + instructions | 8,613 B | 3,720 B (56.8% less) |
| Native explicit workflow response | 78 B | 78 B |
| Page explicit workflow response | 204 B | 208 B |
| Native workflow median | 10.304 ms | 12.314 ms |
| Page workflow median | 2.397 ms | 16.918 ms |

The revised workflow deliberately includes a read after input to keep the
before/after host-action count at three. The dispatch-only regression separately
proves that callers can omit that read. Structured evidence now crosses the
worker boundary; the page fixture transport is slower. These results establish
smaller bootstrap context, not faster execution. Single-observation returned
bytes are essentially unchanged; compact trees were already present before
this refactor. Output spill remains lossless in all benchmark lanes. No new
paid model run, token-cache comparison or matched Codex comparison was made.

Original acceptance boundaries (updated by the follow-up below): truncated browser text cannot establish exact
assertions; incomplete native trees cannot establish absence. Handles persist
in `state`, not as lexical REPL bindings. This work does not add platforms,
annotations, managed profiles or new permissions. Packaging/release validation
and resolution of intermittent Electron AX writes are outside this completed
API change.

## Follow-up review: reliability and agent effectiveness

Requested after the API replacement: identify what remains before claiming
world-class Local Control. The completed refactor establishes a cleaner public
contract. It does not establish broad task reliability or competitive agent
performance. The table tracks both remaining work and the implementation authorized in the
follow-up. See the follow-up acceptance record below for new evidence.

| Ticket | Priority | Improvement | Evidence and acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LC-08 | P0 | Complete uncertainty handling across every execution path | Code review: `controlRaw` checks existing uncertainty but does not record a new uncertain native failure; topology bookkeeping after dispatch is outside the dispatch catch. Reproduce each case with fault injection, then require consistent outcomes and no further affected-target mutation until fresh evidence. Preserve unrelated-target usability and avoid automatic replay. | Pending |
| LC-09 | P0 | Diagnose native Electron writes | Existing legacy live evidence contains one pass and two failures. Trace dispatch through the driver to renderer state, distinguish unsupported/background delivery from transient failures, and select an available page route before dispatch where appropriate. Run repeated cold/warm workflows with independent final-state checks and unchanged foreground. No blind fallback after an uncertain write. | Mitigated in public API; raw driver still fails numeric text. Page and Cocoa acceptance pass. Intermittent legacy driver failures remain unresolved. |
| LC-10 | P1 | Make observation and assertion reads narrowly scoped | Review finding: `expect` requested up to 1,000 nodes every poll with role/name-only selection. Add explicit container/frame scope, targeted exact-value reads and scoped completeness. Test duplicate labels in different forms, long values, virtualized lists and truncated unrelated content. Never recover an expired action ref by guessing a matching label. | Implemented exact container scopes, targeted browser reads and exact values; native reads still fetch up to 1,000 nodes. Virtualized lists and broader frame coverage remain open. |
| LC-11 | P1 | Remove unnecessary capture and transport work | Review finding: native `observe` did not explicitly pass `include_screenshot:false`; verify driver behavior and ensure a semantic read performs no image capture. Profile the page fixture regression (2.397 → 16.918 ms median) by driver, encoding, IPC and validation cost. Measure host reads, capture count, bytes and latency separately. Preserve boundary validation and exact evidence. | Implemented explicit no-image native reads and removed per-node schema construction; final measured evidence below. |
| LC-12 | P1 | Measure real agent task success and release behavior | The new live test covers two short fixture workflows and is not wired into the existing `test:local-control-e2e` package command. Add it to the appropriate acceptance entry point, then add held-out multi-step tasks, dialogs, uploads/downloads, multiple windows, reconnects, cancellation and long sessions. Use repeated runs, independent oracles, completion/false-success rates, foreground changes, tokens, images, latency and human interventions. Test the signed packaged app too. | Partial: repeated live two-form workflows and native/page fixtures; prior Conductor long-task evidence recovered. Packaged and broad cross-provider task evaluation still pending. |
| LC-13 | P2 | Finish the typed public contract and progressive help | Discovery and screenshot methods still return generic JSON; native/browser roles and discovery envelope fields differ. Provide explicit result types, concise examples and target capability information, with unsupported operations discoverable before dispatch. Generate help from the contract where practical and test examples against it. Prefer one coherent API over additional aliases. | Partial: scoped signatures and observed web-field input routes exposed. Generic discovery/result types and broader capability contract remain open. |
| LC-14 | P2 | Scope scheduling and invalidation to actual ownership | `controlTail` currently serializes most calls for one server, while raw calls invalidate every unified view. Establish which read operations and independent tabs can safely overlap, then use target/session ownership to limit invalidation and blocking. Native session/global effects must remain coordinated. Prove no cross-target retargeting, stale reuse or cancellation leaks. | Pending |

Remaining priorities: close LC-08, retain visibility into unresolved native-driver
behavior, and expand LC-12 beyond deterministic fixtures. Broader LC-10 coverage,
LC-13 and LC-14 follow measured caller friction and contention.

Screenshots with annotations, additional platforms, managed browser profiles
and lexical REPL persistence remain possible later work. The current evidence
does not justify prioritizing them over delivery reliability, targeted reads
and measured agent task success. A comparative Codex claim still requires a
matched evaluation; the bootstrap byte reduction alone cannot establish it.

## Follow-up acceptance: typing, scoped reads and capture cost

The user authorized these changes after asking for concrete explanations and
provider-neutral behavior. No further interview decision blocked the work.

- A live six-input audit reproduced numeric text corruption in the installed
  `cua-driver 0.28.0`: `00123` became empty through native AX, with or without
  explicitly focusing the field. The registered page route preserved all six
  inputs. The reference driver source attempts numeric coercion before string
  writes; it also documents renderer/AX disagreement. This does not establish
  the cause of every earlier intermittent alphanumeric failure.
- Public native observations identify web text fields by `AXWebArea` ancestry,
  independent of application name. Their native `setValue` is refused before
  dispatch, with the connected page browser exposed when available. The agent
  must claim and observe the correct page. Native refs never become page refs
  by label matching. Cocoa fields retain native input. Raw native writes remain
  diagnostic and are not claimed reliable.
- Page replacement no longer emits an intermediate empty input event. Browser
  exact-value reads use the matched control's backend identity, preserving
  actual empty and long values. Live forms reject intermediate emptiness and
  have duplicate Email/Save labels; repeated edits verify submitted state and
  the untouched second form through a separate fixture file.
- `within` and `match` are shared contract fields. Visible browser scoped reads use
  `Accessibility.queryAXTree`, skip layout metrics, and retrieve no screenshot.
  Hidden pages use a synchronous snapshot filtered before output; the combined
  live test exposed a rendering-dependent query timeout after a page handoff.
  Native scoped reads filter at most 1,000 driver elements, with incomplete
  coverage retained. Browser main-frame scope and native completeness limits
  are documented rather than hidden behind guessed targets.
- The profiler exposed repeated Zod schema construction for every returned
  page node. Schemas now validate at the boundary and are reused. Native
  semantic reads explicitly pass `include_screenshot:false`; a driver-spy
  regression checks zero image requests and no automatic post-action read.
- `npm run test:control-api-e2e` now runs the public acceptance fixture.
  `npm run audit:control-typing` deliberately exercises raw native writes too.
  The existing legacy e2e's final public Electron operation now uses an exact
  claimed page; its private native-driver diagnostics remain visible.

Codex reference: the installed browser plugin documents nested role/label
locators, strict targeting, fill, and explicit observations. Its behavior guide
asks for the cheapest relevant observation. The installed Computer Use API
exposes native setValue and explicit AX/screenshot reads. These API contracts
inform Mako's design; they do not reveal Codex's proprietary native typing
implementation or prove comparative reliability. Mako's methods run through
one shared server for all providers.

Prior complex sessions do exist: the September 14 Conductor audit traversed
nine settings sections and restored the main screen. Two final recorded passes
took 45.8 and 62.6 seconds, with unchanged foreground. Earlier variants include
failures. This is retained task evidence, not a new release or model comparison.
See [Conductor tasks](audits/2026-09-14/conductor-long-audit-tasks.json) and
[recorded runs](audits/2026-09-14/conductor-long-audit-final.jsonl).

The follow-up does not claim world-class reliability from fixture passes.
LC-08 uncertainty handling, held-out interrupted jobs, packaged release checks,
and broader capability/result typing remain visible above.

Follow-up evidence: [record and limits](audits/2026-09-21/local-control-refactor/follow-up/README.md),
[raw typing audit](audits/2026-09-21/local-control-refactor/follow-up/typing-audit.json),
[workflow run 1](audits/2026-09-21/local-control-refactor/follow-up/public-workflow-1.json),
[workflow run 2](audits/2026-09-21/local-control-refactor/follow-up/public-workflow-2.json).
Final transport medians: page 17.466 → 4.309 ms; native 9.889 → 8.148 ms.
The original pre-refactor page median was 2.397 ms, so this is a measured
improvement over the regression, not a claim that all overhead disappeared.

Final follow-up validation also passed the existing combined live workflow after
fixing hidden-page query stalls: 16 driver programs plus public page input and
assertion across a client handoff (180 ms), Cocoa keyboard checks, and unchanged
foreground. A third public workflow run passed on the final implementation.
See [combined workflow](audits/2026-09-21/local-control-refactor/follow-up/combined-workflow-final.json)
and [final public run](audits/2026-09-21/local-control-refactor/follow-up/public-workflow-final.json).
Control package tests, MCP suite, final host/browser tests, Electron compilation,
scoped ESLint and anti-slop checks passed. No signed build was installed.

## Background parity audit, 2026-09-22

Used the callable Codex browser/native APIs and Mako's public MCP API against
isolated local fixtures, with an independent desktop monitor. This is a macOS
capability comparison, not a matched performance benchmark (Codex Chrome versus
Mako Aside for external browsers). Production routing was not changed.

| Ticket | Finding | Status and acceptance gate |
| --- | --- | --- |
| LC-15 | Native exact-value evidence loses whitespace | **Confirmed correctness failure.** `expect(value:'東京 🐟')` matched while the real Cocoa field held `'  東京 🐟  '`. Reopens native exactness under LC-05. Preserve raw driver values; require both positive and negative exact-value tests. Do not normalize expectations to make them pass. |
| LC-16 | Native background keyboard parity | Codex Command-A selected all text and replacement landed without sampled desktop interference. Mako refused the command before dispatch. Improve and prove the exact-window native driver path before relaxing the refusal. |
| LC-17 | External-browser target detaches during replacement | Two fresh Aside runs completed two submissions and detached on the third `Input.insertText`. Cause unresolved; retain debugger/target lifecycle traces and require a complete passing repeat. Existing Electron page fixtures still pass. |
| LC-18 | Browser connection prerequisite in the public API | Standalone audit required host connection setup before `control.openTab`; public client has no connect method. Clarify the user-connected prerequisite or implement a typed agent connection operation without private escape hatches. |

Evidence: [comparison and limits](audits/2026-09-22/background-control-comparison/README.md),
[native false-positive](audits/2026-09-22/background-control-comparison/native-exactness-results.json),
[desktop monitoring](audits/2026-09-22/background-control-comparison/desktop-summary.json).
Browser-service and computer-host regression suites and the existing public
Cocoa/Electron-page live test passed again. These narrower passes do not establish
parity or override the new failures. Codex native Electron control was not scored:
the fresh intended fixture could not be bound through the available native API.

Native/background parity remains open. Prioritize LC-15 and LC-17 alongside
LC-08, then LC-16 with controlled foreground typing, multi-window, popup, hidden
window and clipboard tests. No focus guard was weakened to claim more support.


## Historical checkpoint: background fixes, 2026-09-22

Work stays below the provider layer. Chromium discovery remains profile-based;
all external-browser reproductions used the registered Aside profile. The current
public API requires an explicit browser ID. Default-browser preference has **not**
been established by this audit; do not equate registration order with OS default.
The old Chrome-only live-test assumption is removed.

- **LC-15:** Shared driver candidate preserves raw AXValue, including empty and
  whitespace-only strings, without falling back to placeholder/display text.
  `value_exact:true` identifies that contract. Mako exposes `valueExact` and
  refuses exact assertions against older normalized values. Candidate passed
  342 Rust library tests (one ignored) and live public MCP positive/negative assertions for
  empty, spaces, padded Unicode, leading-zero numbers and tab/newline strings;
  an independent Cocoa state file agreed. Installed 0.28.0 remains unchanged.
- **LC-17:** A lifecycle trace caught another extension injecting its own iframe
  after text selection, immediately before detach. A controlled iframe-only
  reproduction caused the same detach without typing. Chromium's extension
  debugger permission boundary is the trigger; this is not a demonstrated Aside
  engine or Unicode defect. Router fixes retain tab ownership until `tabs.onRemoved`
  and preserve detach reason. In-flight detach now means unknown outcome, never
  rejected input or permission to replay. Browser restrictions remain intact.
- **LC-16:** An isolated driver candidate posts activation/key-window records only
  to the exact validated target. It never posts a defocus record to the user's
  process or calls SetFrontProcess. A freshly launched inactive Cocoa fixture
  selected 21 characters with Command-A, then a real `x` key replaced them.
  Desktop monitoring now includes WindowServer front PSN and AX focused-element
  identity in addition to app/window, pointer and clipboard counter. Public
  Command restrictions remain until broader acceptance; candidate is not installed.

Evidence and reproducible driver patches are recorded under
[`background-control-fixes`](audits/2026-09-22/background-control-fixes/README.md)
and [`vendor/cua-driver`](../vendor/cua-driver/README.md).


## Agent request failures, 2026-09-22

**LC-19: execution request contract.** Mako's own registered conversation databases
located the reported failure in the dev host journal. Its linked native transcript
records `source` together with `cell:"claude-timeout-hosts"`, then `source` together
with `cell:1`. The agent treated the continuation ID as a script label, then fixed
only its type. This was not evidence of an older string-cell API. A separate
recorded call used `code` instead of `source`.

The shared schema now publishes the exclusive source/cell alternatives, help and
errors show literal start/resume examples, and yielded receipts include their
actual numeric ID in a copyable call. Pre-execution validation errors report
`invalid-request` / `not-dispatched`, not unknown input delivery. Regression tests
include the recorded calls and prove that a malformed resume neither loses nor
replays the running program. The agent benchmark now offers the full tool catalog
and forwards/records actual arguments instead of replacing malformed calls with
an empty source. Live model reliability after these changes remains unmeasured.

See [session evidence and fixes](audits/2026-09-22/background-control-fixes/agent-request-shape.md).


## Background parity re-review, 2026-09-22

**Not ready to claim Codex parity or world-class background reliability.**
[Re-review](audits/2026-09-22/background-control-fixes/parity-review.md) distinguishes
source fixes, candidate-driver results and installed behavior.

- LC-17's cause and cleanup are fixed/understood; completing the original job
  under extension interference remains open. The regression expects interruption.
- LC-16 remains open: public Command shortcuts still refuse; signed integration,
  concurrent foreground typing and multi-window/hidden/popup acceptance are pending.
- LC-15 is corrected in the candidate and fails safely in the updated host with
  the old driver; installed lossless-value support remains pending.
- External Aside screenshot acceptance, OS-default Chromium selection, LC-18
  connection setup and repeated cross-harness job acceptance remain open.

Current installed driver version was rechecked as 0.28.0. This re-review introduced
no routing changes and did not rerun or claim a fresh matched live benchmark.


## Historical checkpoint: release integration and complete-job acceptance

The user authorized shipping and acceptance on 2026-09-22. Driver fixes are now
rebased on upstream `cua-driver-rs-v0.28.2` (`fc188250`), with a distinct
`0.28.2+mako.1` local version. `vendor/cua-driver/release.json` pins the active
candidate. The initial rebase passed 368 macOS tests (two ignored); the new
exact-window key route also passed the shared core tests. Signed packaging is in
progress; the installed upstream application has not been replaced.

The new two-window job test caught `same_pid_keyboard_ambiguity` before dispatch.
The candidate now distinguishes keys delivered after exact native key-window
preparation from old process-scoped input, retaining visibility, identity and
per-process ownership checks. Live sibling-window acceptance is still pending.
A separate foreground fixture counts only its own tagged synthetic keys; it reads
no user keystrokes or other app text. A controlled foreground run is still needed.
External Aside screenshot diagnostics remain open; do not skip them and claim
complete acceptance.


### Signed candidate and job findings

The signed `0.28.2+mako.1` package passed six two-window native jobs plus popup,
minimized, hidden and closed-target refusal. Independent state confirmed one Save
per job and no sibling or popup field changes. Final libraries: 628 core and 368
macOS tests passed, two ignored. The public Command guard remains enabled; a
controlled foreground typing run is still pending. No installed app was replaced.

The normal Aside profile passed a background screenshot and three complete saves
in the longer browser job, then detached during Input.insertText. The job stopped
without replay. The running old extension still lost one task's cleanup ownership.
Fresh isolated screenshots fail in both headless and windowed profiles; normal
profile success does not close this gap.

Current evidence and release gates: [background-control-release](audits/2026-09-22/background-control-release/README.md).

### Native driver installed; browser boundary identified

Local `0.28.2+mako.1` is installed as `/Applications/CuaDriverLocal.app`, selected
by `~/.local/bin/cua-driver` for new launches. The actual installed selection
passed six native jobs with lossless edge values and all four refusal scenarios.
The upstream app and active daemons were preserved. Native Command restrictions
and the foreground-typing acceptance gate remain. See the release audit for
provenance, rollback and the distinction between installed files and active hosts.

The interfering frame belongs to Aside's bundled **Aside Browsing Agent**,
confirmed by its manifest key and the isolated trace. Expanded browser jobs fail
even in a fresh profile; do not label this a user-installed extension or claim
that ownership cleanup prevents detachment. A separate automation profile using
direct CDP is a pending user choice because sign-in/cookies would be separate.

The maintained direct-CDP test now also passes six saved jobs with a foreign
extension iframe deliberately loaded in the target tab. It verifies the frame's
DOM owner, continues editing that same tab, captures screenshots and cleans up.
This supports the proposed route without changing the user's profile policy.
The running existing-profile extension still hits Chromium's restriction; its
failed cleanup left one named local fixture tab, recorded in the release audit.

Pending user answers at this checkpoint: permission/timing for the bounded
foreground typing test, and whether to add the separate direct-CDP automation
profile alongside existing-profile control. The proposed route has now passed
its disposable-profile job test with explicit foreign-frame interference.

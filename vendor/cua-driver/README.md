# Local Control shared driver

## Current source release

`release.json` pins upstream 0.28.2 and the complete `release.patch` for
`0.28.2+mako.31`. +31 is +30 with `0008-windows-daemon-proof.patch` and the
version. +30 is +29 with `0007-linux-no-ffmpeg.patch` and the
version. +29 is +28 with `0005-windows-driver.patch` and the version
(the patch was written beside 0006 as +27 and landed after it, so it is the
later release despite its number). +28 is +26 with `0006-linux-desktop.patch`
and the version. +26 is +25 with `0004-stable-wayland-seat-pointer.patch` and
the version.

### 0008: the Windows daemon proves itself

Three Windows-only changes for the embedded daemon's host:

- A `prove` request. A daemon given a key (`CUA_DRIVER_EMBEDDED_HOST_KEY`,
  at least 32 characters) answers a challenge with HMAC-SHA256, under the
  key, of the challenge, a line feed and its pipe's name, in hex
  (`embedded_host_proof`, `cua-driver-core/src/lib.rs`; the request in the
  Windows `run_serve`). Mako's host gives the key to a driver of this release
  or later, and then asks on every connection before it writes anything else,
  so a process that took the pipe's name is never spoken to, and an answer is
  good for that pipe alone. A daemon given no key answers with an error.
- The key and the host's pid (`CUA_DRIVER_EMBEDDED_HOST_PID`) are read into
  memory first thing in `main` and removed from the daemon's environment
  (`take_embedded_host_secrets`), so no process the daemon starts inherits
  them. The pipe's accept loop reads the pid from memory.
- `launch_app` launches only an installed app, an absolute path, an
  AppUserModelID, a `shell:` item or a URL (`launch_target_is_explicit`).
  Upstream handed anything else to ShellExecute, which searches the current
  folder and `PATH` for a bare name and reads a relative or drive-relative
  path (`sub\tool.exe`, `C:tool.exe`) against the current folder.

### 0007: no FFmpeg in the Linux build

Mako records on Linux with its video helper (`mako-video`: the window on X11,
the monitor the person shares on Wayland) and draws the pointer there, asking
the driver only for its action journal (`record_video: false`). The driver's own
Linux recorders, which piped XComposite and GNOME Shell frames to an `ffmpeg`
from `PATH`, are removed (`platform-linux/src/video_window.rs`,
`video_wayland.rs`); `video_none.rs` refuses `record_video: true` and says to
record through Mako. 0005 compiled `cua-driver-core`'s `video_ffmpeg` and
`ffmpeg_install` out of the Windows build; this moves those conditions from
"not Windows" to "macOS only", so the Linux build has the same stub and
nothing in it can resolve `ffmpeg` or `ffprobe`. `install_ffmpeg` refuses on
both, and the trajectory renderer says the build uses none. FFmpeg stays only
in the Mac build's trajectory renderer and its installer tool, which Mako's
embedded daemon never calls. `cargo test -p cua-driver-core -p platform-linux
--lib` passes on Linux (644 and 454 tests).

### 0005: the Windows driver

Upstream's `platform-windows` is the same driver on Windows: the same tools,
daemon protocol, element tokens, transport-scoped snapshots and embedded
mode, with UI Automation for the tree and actions, Windows Graphics Capture
and PrintWindow for pictures, PostMessage for background input and SendInput
for foreground input. Mako had never built it. These changes make it build and
meet Mako's contract. On a Mac or Linux they add only the MP4 writer (unused
there), `diagnose` skipping its macOS sections on Linux, and wording.

- Window video without FFmpeg. The patch's switch of the X11 recorder to
  `X11VideoBackendFactory` had also replaced the Windows recorder, which does
  not compile on Windows. Windows now records a window through Mako's video
  helper (`mako-video.exe`: Windows Graphics Capture into Media Foundation's
  H.264), run by the whole path the host gives in `CUA_DRIVER_VIDEO_HELPER`
  and refused without one (`platform-windows/src/video_helper.rs`). Its units
  go into fragmented MP4 through `cua-driver-core/src/video_fmp4.rs`, which
  writes the same bytes as Mako's `packages/control-runtime/src/mp4.ts` (one
  fragment a unit, so a crash keeps every unit but the newest). A window that
  closes or changes size ends the recording and keeps what was recorded.
  Whole-display video is refused on Windows.
- No FFmpeg in the Windows build at all: `video_ffmpeg` and `ffmpeg_install`
  are compiled out, `install_ffmpeg` refuses, and what would probe or render
  with FFmpeg finds none. Nothing can resolve an `ffmpeg` from `PATH`. The
  skill pages the driver carries (`Skills/cua-driver/README.md`, `WINDOWS.md`,
  `RECORDING.md`) say how Windows records now; the packaging script refuses a
  Windows executable with FFmpeg's capture, encoder or package names in it.
- The embedded daemon's pipe is the host's alone: its security descriptor
  drops upstream's low mandatory label, so a low-integrity process of the same
  user cannot open it, and a daemon told its host's pid
  (`CUA_DRIVER_EMBEDDED_HOST_PID`) closes a connection from any other process
  before reading a request. Upstream used the pid only for trusted sessions.
  [Local Control on Windows](../../docs/local-control-windows.md#the-drivers-own-pipe)
  has the references.
- Programs by whole path: `cmd.exe`, `powershell.exe`, `schtasks.exe` and
  `taskkill.exe` run from the system directory (`GetSystemDirectoryW`, through
  `cua-driver-core/src/system_program.rs`), never by a bare name that Windows
  looks up beside the driver and on `PATH`. `cua-driver diagnose` runs its
  macOS sections (`codesign`, `sqlite3`) on a Mac only.
- Exact values, as `0001-lossless-values.patch` gives the Mac and the Linux
  build gives AT-SPI: a ValuePattern control's value is sent as UI Automation
  holds it, empty and whitespace included, with `value_exact: true`, and Mako's
  runtime compares it with what it wrote. Without it every `expect({value})`
  was refused as display-normalized text. A Win32 edit or rich edit without a
  ValuePattern (Windows 11 Notepad's editor) is read whole through TextPattern,
  up to 100,000 UTF-16 units, the AT-SPI limit; a longer text is cut and not
  exact. A browser's Document is never read this way. Password fields are never
  read.
- A foreground `hotkey` to a XAML host (Notepad, Terminal, Calculator) is sent
  through SendInput as the caller asked. It used to take the background
  accelerator scan, which refuses any chord the window has no named button for.
- Background typing posts a character past U+FFFF (an emoji, a CJK
  extension) as its UTF-16 surrogate pair, as a keyboard does. Its whole code
  point in one `WM_CHAR` was dropped by every Unicode window.

`node scripts/package-control-driver-windows.mjs <checkout>` builds
`release/control-driver/<version>/windows-x64/` on Windows: one
`cua-driver.exe` with the C runtime linked in (`+crt-static`, so it imports no
`vcruntime`/`ucrtbase`), its x64 machine type and imports checked, every linked
crate's license checked for GPL, and the hashes in `provenance.json`. The
`Windows computer control` workflow builds it on `windows-latest` and drives
it; see [Local Control on Windows](../../docs/local-control-windows.md).

### 0006: a person's Linux desktop

Five Linux-only changes for running on a person's desktop rather than an
isolated test session:

- The GNOME Shell helper (`winrects@cua`, now v11) holds its agent cursor
  still at rest. Its 33 ms timer used to repaint the floating cursor for as long
  as it stayed up, so GNOME redrew the screen at 20–26 fps with nothing
  happening, which a screen cast and a laptop's battery paid for. The timer now
  runs only while an action, a badge or a fade animates, and stops itself.
- The Shell helper's cursor respects the daemon and the session: a
  `--no-overlay` daemon (Mako's embedded one) shows none, and a session that
  turned its cursor off (`set_agent_cursor_enabled(false)`) stays off. The
  helper keeps no per-session state, so a later click used to show it again.
- `launch_app` splits `Exec=` as the desktop entry spec quotes it (double
  quotes, `\"`, `` \` ``, `\$`, `\\`), undoes the value's own escapes and
  drops field codes (`%%` is a percent sign). It used to split on spaces, so an
  entry with a quoted path or title launched the wrong arguments.
- Sway's tree failed to parse whenever an XWayland window was open: Sway
  sends `"app_id": null` for one (and `"name": null` for a split container),
  which the driver read as a string. Every Sway lookup (windows by pid, focus,
  geometry) then answered nothing, so a native app such as foot went missing
  from the window list too. Both are now read as empty when null.
- An XWayland app under Sway is named by its X11 window id, which no
  foreign-toplevel handle carries, so activation refused it. Sway's tree
  carries the id (`window`): the exact container is focused and its focus
  confirmed there, and focus attestation accepts that id.

`cargo test -p platform-linux --lib` passes (454 tests, five ignored). The
desktop acceptance is `scripts/linux-control/run-desktop.sh`. +25 is +24 with `0003-transport-scoped-snapshots.patch`
and the version.

### 0004: a stable Wayland seat pointer

Each wlroots gesture (click, scroll, drag, held button) creates its own
`zwlr_virtual_pointer_v1` and destroys it afterwards. On a seat with no other
pointer, such as headless Sway or a nested compositor, that device was the
seat's only pointer. Creating it made the compositor announce
`wl_seat.capabilities(pointer)`, and destroying it withdrew the capability
along with every client's `wl_pointer`. An app receives pointer events only
after it answers the announcement with `wl_seat.get_pointer`; wlroots drops
what it would have sent the app before that. The drag's first motion reaches
the compositor in the same flush as the new device, and the press follows
15 ms later, so an app whose main loop was busy for longer lost the press and
the start of the drag. That was the intermittent `Exactly one drag press
reaches the app` failure in the Sway acceptance suites: the app recorded no
press and no motion before about 100 ms, then the rest of the drag and the
release. The injecting client cannot see another client's binding, so no
wait before the press could be correct.

The daemon now creates one idle virtual pointer on the primary seat before it
binds its socket, and keeps it on its own connection until the compositor goes
away. The seat's pointer capability no longer changes while the daemon runs:
apps bind their pointer once, when they start or when the daemon does, and
each gesture's device joins a seat that already has one. The held device sends
no events. Seats that already have a pointer, X11, and compositors without
wlroots virtual pointers (GNOME and KDE use libei) see no change.

### 0003: transport-scoped snapshots

Upstream keeps one element snapshot per window for every caller
(`ElementCacheCore`, keyed by pid, one entry per window): any client's
`get_window_state` tree read replaces the window's snapshot, so every other
client's `element_token`s for that window go stale. Two agents, or an agent
and a person's capture, on one daemon retire each other's tokens.

The patch keys snapshots by owner. An owner is a retained transport, a
connection that said `session_begin` and stays open (an MCP proxy, Mako's
driver broker lease). A tree read replaces only its own transport's earlier
read of the window, and resolving a token looks only in the caller's own
snapshots: another transport's token is refused as `foreign_element_token`,
which says whose it is rather than calling it stale. Calls without a retained
transport (one-shot CLI calls, the in-process SDK) share one lane, exactly as
before, so `cua-driver call get_window_state` and a later `cua-driver call
click` from another process still pair up. Each owner keeps at most 8
snapshots per process and 32 in all, the oldest going first; at most 256
owners hold snapshots; all of them together hold at most 262,144 elements,
past which the least recently reading owner's oldest snapshot goes (never the
read just made). On macOS an element is one retained AXUIElement (48 bytes,
measured with `malloc_size`) and an 8-byte slot, so the store stays near
14 MB. A transport's snapshots are released the moment its
control connection closes (the lease drop that ends its sessions). An evicted
or released snapshot's tokens are refused as `stale_element_token`. Snapshot
numbers start at a random point in each process: upstream counted from 1, so a
token minted by a daemon that died could name the replacement daemon's
snapshot of the same number and act on whatever element sat at that index. The owner
comes from the dispatch's trusted transport evidence through a task-local, as
the runtime scope does, so no tool or platform call site changed and Linux and
Windows get the same behaviour. `verify_state` and actions never publish
(observation-only reads), so only `get_window_state` with its tree replaces
anything.

The daemon advertises it: `metadata.snapshot_scope: "transport"` (absent from
older daemons; serde-default, so older and newer peers interoperate), and the
operator `sessions_list` reply carries `snapshots`, each owner's snapshot and
element counts, never contents. Mako's broker reads `snapshot_scope` once per
daemon and keeps its supersession notices only for a daemon without it; it
refuses a daemon whose `contract_version` is not `0.8.x`.

The patch applies on top of `release.patch` +24 (it builds on +24's retained
transports, so not to the upstream base alone). Evidence:
[driver-snapshots](../../docs/audits/2026-10-12/driver-snapshots/README.md).

+24 releases input a dead daemon left held on macOS: each
key or button press is journaled beside the socket before it is posted, the
next daemon on that socket posts the missing releases to the same process (pid
and start time), and SIGTERM or clean shutdown releases held input and deletes
the journal. +24 also stops confirming typed text merely because the field
already contained it. See the
[driver-death evidence](../../docs/local-control-map.md#lc-08--lc-14--uncertainty-ownership-and-independent-targets).
+22 retains recording context through right/double-click
blocking workers. +23 retains connected implicit sessions across SDK idle cleanup;
named TTL, explicit end and transport-close cleanup remain enforced. See
[media and lifecycle evidence](../../docs/local-control-media-fixes.md).
The earlier +21 release adds bounded attached-sheet
discovery shared by observation and exact input validation. It still requires the
sheet's own CGWindowID; no title, geometry or parent-window substitution is allowed.
Mac +21 is signed and installed for new launches; exact file selection and
cancellation pass through the CLI. Incomplete panel coverage and cross-process
dialogs remain gates; see [the evidence](../../docs/local-control-file-sheet-evidence.md). Mac lossless values
and keyboard changes are retained. Linux adds
exact values and coverage, retained accessibility objects for semantic input,
modal refusal and focus checks before foreground input. Non-actionable rows can
omit `element_index`; the host handles them as readable containers.

+mako.17 repairs no-overlay notification delivery and checks WindowServer
identity when an activation notification precedes the NSWorkspace cache update.
Three system-activation trials restore the original app and retain interruption
receipts; continuation requires observation. This is reactive recovery, with
23–99 ms between the fixture's activation notifications. Physical typing and
general proactive prevention remain unproven. Wayland drag duration is now
honored; four packaged scale/rotation/load workflows pass with forty hidden jobs.
See the [current evidence](../../docs/audits/2026-09-23/local-control-focus15/README.md).

+mako.14 fixes fractional-scale pointer coordinates and rotated/mirrored native
screenshots on Wayland. It uses compositor logical geometry and lossless pixel
transforms. Eleven packaged Sway workflows pass, including combined 150% scale
and 90° rotation. This does not extend acceptance to untested compositor families
or prove general Mac focus-steal prevention. Direct Mac comparisons and rejected
approaches are recorded in the
[continuation report](../../docs/audits/2026-09-23/local-control-focus14/README.md).

This release adds owned exact-window recording: ScreenCaptureKit on macOS and
XComposite on X11. Physical cursors are excluded. Actual native click, move, drag and scroll
dispatches feed the host's recorded cursor; semantic input invents no movement. Target loss or resize ends capture explicitly;
playable early-ending video is retained with an interruption reason. Native AX
walks have deadline/cancellation limits. Mac actions report bounded accessibility
notification settling separately from action success. A stalled observer cannot
establish quiet; callers still verify the intended result explicitly. Optional
unsupported AppKit identifiers do not incorrectly mark an entire tree incomplete.
Focus restoration ignores stale activation notifications. Raw background clicks
prepare only the target process and never defocus the user's app. Right-clicks
use one transport; middle-clicks include exact window routing. General focus-steal
interception and physical IME/concurrent typing remain unproven.

`node scripts/package-control-driver-linux.mjs <checkout> --arch=arm64` builds Linux using the
image in [scripts/linux-control](../../scripts/linux-control/README.md). The package
records source, patch, image and binary hashes and retains Cua's MIT license.
Linux ARM64/X11, Sway and GNOME 46 have scoped acceptance. GNOME helper v10 retains
exact-window texture capture and covered video, and checks Overview/modal/lock
state before attesting keyboard focus. Minimization ends capture and
retains playable partial video. The helper and installer ship with the Linux
package. Sway hidden capture/video and other compositors remain unverified. Linux x64
passes complete jobs and X11 recording under OrbStack translation.
Native AMD +19 acceptance covers X11 jobs/gestures/recording, Sway scale and
rotation and standalone lifecycle; see [platform validation](../../docs/local-control-native-validation.md).
Linux +24 is packaged for ARM64 and x64 and passes the same suites on ARM64 (plus
labwc/Weston/KWin, GNOME 46 and the CLI/lifecycle jobs) and on translated x64
([evidence](../../docs/audits/2026-09-26/linux24/README.md)). Native x64 has not
rerun on +24. The held-input journal is macOS-only.

`node scripts/package-control-driver.mjs <checkout>` signs the Mac build and checks
its binary/version. `node scripts/install-control-driver.mjs` installs the manifest's
verified package from `release/control-driver/<version>/` into
an immutable version under `~/Library/Application Support/mako/control-drivers/`
and atomically selects it through `~/.local/bin/cua-driver`. The installer verifies
provenance/signature before selection, keeps the previous executable for running
daemons and rollback, and refuses unknown launcher targets or another install lock.
It does not restart active daemons. The selection receipt records the active version for new launches; the running
Mako host and daemon deployment remain separate.

Installer upgrade/repeat/lock/verification-failure tests and signed installation
passed. The preceding +mako.12 release passed 375 Mac tests (two existing ignores) and
448 Linux tests (five existing ignores). +mako.13 has 632 core and 455 Linux unit
passes, signed Mac foreground drag/recording acceptance, GNOME libei gesture and
recording acceptance, and Sway 1×/2× screenshot/input acceptance. Final X11 held-button
recording, covered video and interruption retention pass on Linux x64, alongside
30 complete save jobs and 400/400 tagged concurrent keystrokes. The shared X11
encoder regression also passed; an intermittent unmanaged-window setup failure
remains documented separately.
See the [current wayfinder](../../docs/local-control-map.md) and
[current acceptance evidence](../../docs/audits/2026-09-22/local-control-acceptance13/README.md)
for live results and remaining gates. These are locally signed builds, not a
notarized public release.

## Historical prototype

The two numbered patches below are retained as provenance for the earlier
experiment. They are not the active release recipe.

These are patches to the shared Cua driver, not another native automation
implementation. Every Mako provider uses the same host and driver contract.

Base: [trycua/cua c43f10243856658fe706c08c155a95628fc81248](https://github.com/trycua/cua/commit/c43f10243856658fe706c08c155a95628fc81248).
The source checkout reports workspace version 0.20.0. Mako's installed external
release is 0.28.0; these are distinct builds. Do not replace the signed external
application with this debug binary or advertise it as a released driver update.

- `0001-lossless-values.patch` keeps raw AXValue separate from display text,
  preserves empty/whitespace strings and exact signed integer values, and emits
  `value_exact:true`. It removes placeholder fallback from structured values.
- `0002-background-key-window.patch` shares exact-window responder preparation
  between press_key and hotkey. It posts only to the validated target, never
  defocuses another process, never raises a window and never calls SetFrontProcess.
  Command events take AppKit's menu path. Existing exact-window validation and
  mutation leases remain mandatory. Public Mako Command guards remain enabled.

To reproduce in a separate checkout (never edit Mako's `ignore/` references):

```sh
git clone https://github.com/trycua/cua.git /tmp/mako-control-driver
cd /tmp/mako-control-driver
git checkout --detach c43f10243856658fe706c08c155a95628fc81248
git apply /absolute/path/to/mako/vendor/cua-driver/0001-lossless-values.patch
git apply /absolute/path/to/mako/vendor/cua-driver/0002-background-key-window.patch
cd libs/cua-driver/rust
CARGO_BUILD_JOBS=2 cargo test -p platform-macos --lib
CARGO_BUILD_JOBS=2 cargo build -p cua-driver
```

Use that checkout's `libs/cua-driver/rust/target/debug` at the front of PATH
when running Mako's `node scripts/test-control-api-e2e.mjs` after compiling
Mako and `@mako/control`. This selects an isolated daemon; it does not install
or update CuaDriver.app. The test checks raw values through public MCP calls
against an independently written Cocoa state file.

Acceptance evidence and remaining gates:
[background-control-fixes](../../docs/audits/2026-09-22/background-control-fixes/README.md).
Release integration, signed packaging, multiple native windows, hidden windows,
popups and concurrent foreground typing remain required before broader keyboard
support is enabled. Patch provenance is upstream Cua (MIT); preserve its license
and contributor credit when distributing a built driver.

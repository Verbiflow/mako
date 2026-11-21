# Local Control on Windows

Windows uses the same native driver as the Mac and Linux: upstream Cua's Rust
driver with Mako's reviewed patch (`vendor/cua-driver`), built for Windows x64.
Upstream's `platform-windows` already speaks the driver contract Mako's runtime
is written against: the same tools and schemas, the daemon's line protocol,
`session_begin` leases, element tokens with transport-scoped snapshots, and
embedded mode. Mako builds it, wires the host to start it, and patches what its
contract needs (`0005-windows-driver.patch`, described in the
[driver README](../vendor/cua-driver/README.md#0005-the-windows-driver)).

## How it runs

- `scripts/package-control-driver-windows.mjs` builds one `cua-driver.exe`
  (about 31 MB, the Mac build is 32 MB) with the C runtime linked in, checks
  its machine type, that it imports no C runtime DLL, and that no linked crate
  is GPL-only, and records its hashes in `provenance.json`.
- The host's `CuaEmbedded` starts it as on a Mac (`serve --embedded
  --no-overlay`), on a named pipe `\\.\pipe\mako-cua-<host pid>-<random>`
  instead of a Unix socket. The daemon creates the pipe with a current-user
  ACL and reserves the name, and serves only the host's own process, by the
  pid it is given (`CUA_DRIVER_EMBEDDED_HOST_PID`), since a pipe has no peer
  credentials to read a parent from (see "The driver's own pipe"). It exits when the host's end of its stdin closes, so a
  host that is killed leaves no driver; the host stops it the same way and
  terminates it two seconds later if it is still there.
- The `DriverBroker` gives tasks their grants on the host's proven pipe (the
  handshake in `@mako/lazy/private-pipe`); a lease still needs its grant's token.
- The host finds `cua-driver.exe` through its trusted lookup (`base/executable.ts`):
  in `PATH`'s whole-path folders or `~\.local\bin`, and only where no other
  account could have put it; never by a bare name. Packaging has to put it in
  such a folder. The host never runs upstream's updater over Mako's build
  (a `+mako.` version is refused). The driver runs with its own folder as its
  current folder, so nothing it names without a folder is found in the folder
  the host started in.
- Windows asks no permission to capture windows or drive UI Automation, so the
  host reports access as granted and shows nothing to allow.

## What the runtime gets, against the Mac

| | Mac (AX, ScreenCaptureKit, CGEvent) | Windows (UI Automation, WGC/PrintWindow, PostMessage/SendInput) |
| --- | --- | --- |
| Apps and windows | `list_apps`, `list_windows` | Same tools and fields. Windows are top-level HWNDs; invisible and DWM-cloaked windows (other virtual desktops, suspended UWP) are left out. Installed apps include Store apps by AppUserModelID. |
| Window state | AX tree, element tokens, screenshot | UI Automation tree (one cached subtree request), the same element tokens and snapshot scoping, a PNG of the window. Roles are UI Automation's control types; Mako maps them to the same vocabulary (`Edit` reads as `TextField`). |
| Exact values | `value_exact` (0001) | `value_exact` from ValuePattern; Win32 edits without one (Notepad) read through TextPattern. |
| Screenshots | window, display, zoom | Same: `get_window_state`, `get_desktop_state`, `zoom`. Per-monitor DPI aware (the driver's manifest). |
| Background element actions | AXPress, AXValue | InvokePattern, TogglePattern, ValuePattern, ScrollPattern. Verified: set, press, toggle, scroll. |
| Background pointer | CGEvent to the pid | PostMessage to the deepest child window under the point, with the window kept from activating. Verified: click, double click, right click, drag, landing on a window covered by another, with the foreground and the pointer unchanged. Classes known to drop posted input (Chromium, GTK, VCL; posted wheels on Windows Forms) are refused with `background_unavailable`, not reported as done. |
| Background keys | pid-routed keys | PostMessage `WM_CHAR`/`WM_KEYDOWN` to the window's focused control. Unicode text and keys verified. An emoji now arrives as its surrogate pair (the Windows Forms edit under test kept only the first half of it). Chords cannot carry modifier state by posting; XAML hosts (Windows 11 Notepad) ignore posted keys, and the driver says so and asks for foreground. |
| Foreground | declared, verified frontmost | Same declaration. SendInput with absolute virtual-desktop coordinates; verified: click, `ctrl+a`, typing, wheel, drag. `bring_to_front` works despite the foreground lock (`AttachThreadInput`). |
| Launch and focus | `launch_app` by bundle id | By name, path, or AppUserModelID (`shell:AppsFolder`), without fronting. |
| Clipboard | text, image, file | Same tools; text and image verified against Windows' own clipboard. |
| Menus | `invoke_menu` | The tool exists; not verified, so the route stays unavailable. |
| Recording | ScreenCaptureKit into MP4 | Mako's video helper (`mako-video.exe`, Windows Graphics Capture into Media Foundation H.264), run by the whole path the host gives, its units written as fragmented MP4 by the driver, the same bytes `mp4.ts` writes. No FFmpeg anywhere in the build. A pointer is kept in the timeline, not drawn into the video. Verified: driver and task recordings read back with Mediabunny, with no FFmpeg on `PATH`. |
| Held input after a crash | journaled and released (+24) | Not ported; the journal is macOS-only. |

Routes Mako's runtime offers on Windows (`control-contract.ts`): command,
accessibility and window pointer in the background; foreground by declaration.
The pid keyboard stays unavailable: an element-addressed key focuses the
element through UI Automation's `SetFocus`, which brought the window forward in
some runs on the runner. Typing into a background window works when its focused control is
the target (a posted click puts the caret there first), but the runtime cannot
yet promise that. Menus stay unavailable until `invoke_menu` is verified.

## The driver's own pipe

For a reviewer: who can reach the embedded driver on Windows, and why. Line
numbers are in `libs/cua-driver/rust/crates/cua-driver/src/serve.rs` of the
pinned upstream source with `vendor/cua-driver/release.patch` applied (the
Windows `run_serve`); the two changes Mako makes are in
`vendor/cua-driver/0005-windows-driver.patch` (its `serve.rs` hunks).

- **Name.** The host draws `\\.\pipe\mako-cua-<host pid>-<128 random bits>`
  and passes it as `--socket` (`packages/host/src/control/cua-embedded.ts`,
  `daemonEndpoint`). The name is not a secret: Windows lists pipe names, and
  the daemon's command line shows it. Nothing below depends on it being one.
- **Who holds the name.** The embedded daemon creates its first instance with
  `FILE_FLAG_FIRST_PIPE_INSTANCE` (line 1792, `first_pipe_instance`). If
  another process made the name first, creation fails, the daemon exits, and
  the host reports the driver as not started.
- **ACL.** Every instance is created with an explicit security descriptor
  (line 1802; a daemon that cannot build one refuses to start, line 1748). For
  an embedded daemon it is `D:P(A;;GA;;;<this user's SID>)`
  (`build_pipe_security_attrs`, line 1705): a protected DACL with one entry,
  so no other account is granted access (an administrator can take ownership
  of it, as of any object). It carries no mandatory label of its own, so the pipe has
  the daemon's integrity level with no-write-up: a low-integrity process of
  the same user cannot open it. Upstream labelled it Low (`S:(ML;;NW;;;LW)`),
  which let a sandboxed process of the same user in; Mako's patch removes that
  for the embedded daemon and leaves the standalone service as it was.
  Tokio's `ServerOptions` rejects remote clients by default
  (`PIPE_REJECT_REMOTE_CLIENTS`, tokio 1.52.1 `named_pipe.rs`).
- **Each connection, before a byte is read.** The client's process id comes
  from the kernel (`GetNamedPipeClientProcessId`, line 1586). Its token's user
  SID (`named_pipe_client_sid`, line 1600) must equal the daemon's own
  (`current_user_sid_string`, line 1506; the comparison at line 1817), or the
  instance is disconnected.
- **The host's pid.** The host starts the daemon with
  `CUA_DRIVER_EMBEDDED_HOST_PID=<its pid>` (`cua-embedded.ts`). Upstream used
  the match (`trusted_host_connection`, line 1830) only to allow trusted
  service sessions; any process of the same user could still send `call`.
  Mako's patch closes every connection from another process (line 1838), so
  the daemon serves the host's process and nothing else. Every caller of the
  driver, the person's Appshots and each task's worker, goes through the
  host's `DriverBroker`, which is behind its own proven pipe. A pid is only
  reused after its process ends, and the daemon ends with the host: it reads
  the host's end of its stdin and exits when that closes (line 1771,
  `wait_for_parent_stdin_eof`, line 724; `CUA_DRIVER_PARENT_LIVENESS_STDIN`).
- **A daemon that could not start.** A process that takes the pipe's name
  before the daemon creates it makes the daemon exit at once. The host counts
  a daemon as started only if it is still running a moment after something
  first answers on the name (`cua-embedded.ts`, `STARTED_SETTLE_MS`), and when
  the daemon's process exits the broker closes every connection to its
  endpoint (`DaemonPeer.gone` in
  `packages/control-runtime/src/driver-daemon.ts`), so a call in flight fails
  as the driver having stopped, whoever holds the name.
- **The daemon's environment is the host's alone.** Every `CUA_DRIVER_*` and
  `CUA_TELEMETRY_ENABLED` variable the host inherited is dropped before its
  own are set (`driverEnvironment`, `cua-embedded.ts`), on every platform, so
  a person's `CUA_DRIVER_RS_MCP_HTTP_PORT` or
  `CUA_DRIVER_ENVELOPE_HTTP_PORT` opens no loopback listener beside the pipe
  and no inherited policy or permission setting applies.
- **The host knows its daemon.** On Windows, where the endpoint is a pipe
  whose name anyone can take, the host starts a driver of release `+mako.31`
  or later with a 256-bit key in its environment
  (`CUA_DRIVER_EMBEDDED_HOST_KEY`, `cua-embedded.ts`). It reads the release
  from the executable it found itself (`--version`), never from the pipe; an
  older driver is started without the key, as before, and the host's log says
  so. A Mac's or Linux machine's driver, on a socket in a folder only this
  user can open, is never asked. On every connection it makes
  (`packages/control-runtime/src/driver-daemon.ts`, `connect`) it first sends
  a random challenge (`prove`) and reads back HMAC-SHA256 of it under the
  key (`embedded_host_proof` in `cua-driver-core/src/lib.rs` and the `prove`
  request in `serve.rs`, both in `0008-windows-daemon-proof.patch`), compared
  in constant time, before it writes anything of its own. A process holding
  the pipe's name is sent a challenge and nothing else, and only a proven
  answer counts as the daemon having started.
- **What this does not cover.** The boundary is the user account at the
  host's integrity level: a process of the same user at that level can read
  the daemon's environment, key included, or write the host's memory, and so
  act as either. It gains nothing over reading the screen and sending input
  itself, which that user can do.

`scripts/test-control-driver-windows.ts` checks, against the running daemon:
the host's process is answered, another process of the same user is closed
on unanswered, a low-integrity one cannot open the pipe, the daemon proves
itself while a wrong key or an impostor's pipe is refused with only challenges
sent, and no TCP port listens with the two port variables set in the host's environment.
`scripts/test-cua-embedded-environment.ts` checks the environment a stand-in
driver is started with on a Mac and Linux.

`launch_app` by a bare name: on Windows the host's broker lets the name
through only when the driver lists an installed app by it, sends the whole
path instead when the host's trusted lookup finds a program of that name, and
answers the call itself otherwise (`launchable` in
`packages/control-runtime/src/driver-broker.ts`). The driver's own fallback, a
ShellExecute search of the current folder and `PATH`, is never reached with a
bare name, and from `0008` the driver itself refuses a name that is no
installed app.

## Elevated windows (UIPI)

Windows drops input a process sends to a window of a higher integrity level,
and `PostMessage` and `SendInput` still return success. Mako's driver runs at
the person's normal (medium) integrity, so an app run as administrator is above
it. The driver checks each target's integrity before posting and refuses with
an explanation naming both levels; nothing is reported as delivered. UI
Automation is limited the same way. Driving an elevated app needs the driver
to run elevated, or the uiAccess helper upstream ships (`cua-driver-uia`, which
must be signed and installed under Program Files); Mako ships neither. The
workflow checks the refusal with a copy of the driver labelled Low integrity
against the runner's High-integrity fixture.

## Measured on windows-latest

Hosted runner, Windows Server 2025, 1024×768 at 100%, a Windows Forms fixture
in the background behind another window. Each figure is the median and p90 of
ten warm calls through the host's `DriverBroker`, the way a task's calls go,
from run 44830645356. Hosted runners differ: on a slower one the tree reads and
the pixel click took up to 1.7 times as long (190 ms and 250 ms medians).

| Operation | Median | p90 |
| --- | --- | --- |
| `list_windows` (one process) | 20 ms | 20 ms |
| Window screenshot, no tree | 49 ms | 77 ms |
| `get_window_state`, tree and screenshot (213 elements) | 110 ms | 173 ms |
| `get_window_state`, tree only | 85 ms | 94 ms |
| `zoom` | 16 ms | 32 ms |
| Display screenshot (`get_desktop_state`) | 31 ms | 46 ms |
| Click by element token | 8 ms | 9 ms |
| `set_value` | 8 ms | 18 ms |
| `type_text`, 10 characters | 8 ms | 9 ms |
| `press_key` | 5 ms | 5 ms |
| Click at window pixels (background) | 166 ms | 208 ms |
| Appshot through the broker | 118 ms (one) | |

The background pixel click is slow by design: it waits for the posted burst to
settle before checking that the window did not come forward. The daemon starts
in about 120 ms at 20 MB.

Idle, after the work above, with the broker's lease still open, over 90 s: no
measurable CPU (Windows counts CPU time in 15.6 ms ticks). The driver's threads
switched context in two bursts in the first 35 s, most likely the idle-session
sweep releasing the test's sessions and their UI Automation snapshots, and then about 0.1 times a second for the
remaining 55 s: one wake every 30 s, the upstream lifecycle thread's, as on a
Mac. 73 MB working set, 31 MB private, 14 threads. The host side has no timer
of its own for the driver.

## Checks

`.github/workflows/windows-control.yml` builds the package and runs
`scripts/test-control-driver-windows.ts`, which starts the driver through the
host's `CuaEmbedded`, leases it through `DriverBroker`, and checks every result
against what the window received: the fixture
(`scripts/fixtures/win-control-fixture.ps1`) writes its field, button presses,
check box, list position, every mouse message its canvas's window procedure
receives and every key to a file. It also drives Notepad and Calculator,
Appshots, and a task's control session through the public program API.

## What is left

- The host itself on Windows (another change): until it lands, the driver is
  checked through the host's own modules rather than a running host. Once it
  does, run a task end to end: `computer` use from a Thread on a Windows host,
  observe, set a field, click, and an Appshot.
- Packaging `cua-driver.exe` with the Windows app, beside the executable or in
  `~\.local\bin`, from the package this script builds, and `mako-video.exe`
  where `MAKO_VIDEO_HELPER` points: the host passes that whole path to the
  driver, which records no window video without it.
- Background keys without UI Automation focus (post to the element's own window
  handle), proven on an interactive desktop, before the pid keyboard is offered.
- `invoke_menu` and multi-monitor or high-DPI scaling were not exercised; the
  runner has one 100% display. A recorded window that changes size ends its
  recording there (as on the other platforms), which was not exercised either.
- Signing the executable.

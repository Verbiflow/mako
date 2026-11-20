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
  ACL and reserves the name; it trusts the host's connections by the pid it is
  given (`CUA_DRIVER_EMBEDDED_HOST_PID`), since a pipe has no peer credentials
  to read a parent from. It exits when the host's end of its stdin closes, so a
  host that is killed leaves no driver; the host stops it the same way and
  terminates it two seconds later if it is still there.
- The `DriverBroker` gives tasks their grants on a named pipe too
  (`\\.\pipe\mako-driver-<pid>-<random>`); a lease still needs its grant's token.
- The host finds `cua-driver.exe` on `PATH` or in `~\.local\bin`, as it finds
  `cua-driver` elsewhere. Packaging has to put it in one of those, or the host
  has to be told where it is.
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
| Recording | ScreenCaptureKit | The driver's FFmpeg recorder; Mako's own window video is the video helper's (Windows Graphics Capture, PR #1108). Not part of these checks. |
| Held input after a crash | journaled and released (+24) | Not ported; the journal is macOS-only. |

Routes Mako's runtime offers on Windows (`control-contract.ts`): command,
accessibility and window pointer in the background; foreground by declaration.
The pid keyboard stays unavailable: an element-addressed key focuses the
element through UI Automation's `SetFocus`, which brought the window forward in
some runs on the runner. Typing into a background window works when its focused control is
the target (a posted click puts the caret there first), but the runtime cannot
yet promise that. Menus stay unavailable until `invoke_menu` is verified.

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
  `~\.local\bin`, from the package this script builds.
- Background keys without UI Automation focus (post to the element's own window
  handle), proven on an interactive desktop, before the pid keyboard is offered.
- `invoke_menu`, multi-monitor and high-DPI scaling, and recording on Windows
  were not exercised; the runner has one 100% display.
- Signing the executable.

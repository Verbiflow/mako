# Local Control shared driver

## Current source release

`release.json` pins upstream 0.28.2 and the complete `release.patch` for
`0.28.2+mako.17`. Mac lossless values and keyboard changes are retained. Linux adds
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
passes complete jobs and X11 recording under OrbStack translation; native
Intel/AMD hardware performance is not established.

`node scripts/package-control-driver.mjs <checkout>` signs the Mac build and checks
its binary/version. `node scripts/install-control-driver.mjs` installs the manifest's
verified package from `release/control-driver/<version>/` into
an immutable version under `~/Library/Application Support/mako/control-drivers/`
and atomically selects it through `~/.local/bin/cua-driver`. The installer verifies
provenance/signature before selection, keeps the previous executable for running
daemons and rollback, and refuses unknown launcher targets or another install lock.
It does not restart active daemons. Version `0.28.2+mako.17` is now selected on this
Mac for new launches; the running Mako host/extension deployment remains separate.

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

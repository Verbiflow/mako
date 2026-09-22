# Local Control shared driver

## Active local release

`release.json` pins the upstream 0.28.2 release and the complete `release.patch`.
The local version is `0.28.2+mako.1`. Build and certificate-sign the exact patched
checkout with `node scripts/package-control-driver.mjs <checkout>` from Mako.
The script verifies the base commit, patch, final signature and reported version,
and records hashes beside the app. It does not install or replace a running driver.

`scripts/install-control-driver.mjs` installs the verified package separately as
`/Applications/CuaDriverLocal.app` and atomically selects it for new launches via
`~/.local/bin/cua-driver`. It preserves the upstream app, records rollback, and
leaves active daemons running. This local installation has been completed and
verified on this machine. It is not a notarized public release.

The installed executable passed six complete jobs across two native windows, with
exactly one Save per job, independent state checks, and refusal of parent-window
input during a popup plus minimized, hidden and closed targets. Public Command
restrictions remain until controlled foreground typing acceptance. See the
[release evidence](../../docs/audits/2026-09-22/background-control-release/README.md).

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

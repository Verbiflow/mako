# Local Control shared driver

## Current source release

`release.json` pins upstream 0.28.2 and the complete `release.patch` for
`0.28.2+mako.3`. Mac lossless values and keyboard changes are retained. Linux adds
exact values and coverage, retained accessibility objects for semantic input,
modal refusal and focus checks before foreground input. Non-actionable rows can
omit `element_index`; Mako's shared host handles them as readable containers.

Use `node scripts/package-control-driver-linux.mjs <checkout>` with the image in
[scripts/linux-control](../../scripts/linux-control/README.md) to build Linux.
The package records the source, patch, image and binary hashes and keeps Cua's
MIT license. It does not install or replace a running driver. Linux ARM64/X11 is
the tested platform; x64 and Wayland need separate acceptance.

For Mac, `node scripts/package-control-driver.mjs <checkout>` certificate-signs
the exact pinned source and verifies the final binary/version. The installed Mac
driver remains `0.28.2+mako.1`, with the earlier six-job and 995-key evidence.
This iteration does not claim a new Mac driver installation or notarized release.
The common contract and Mac native unit suites passed after the contract change.

The earlier installer selects `/Applications/CuaDriverLocal.app` atomically for
new launches and preserves active daemons. It currently verifies an existing
installation against the candidate; it is not an automatic in-place version
upgrader. Do not run it against the older installed app and assume an upgrade.

See the [implementation evidence](../../docs/audits/2026-09-22/linux-control-implementation/README.md)
and [earlier Mac release evidence](../../docs/audits/2026-09-22/background-control-release/README.md).

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

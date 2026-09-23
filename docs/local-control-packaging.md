# Local Control packaging

## What is retained

Every harness calls Mako's shared Local Control API. Browser actions use Mako's
browser service and extension; they do not load Cua. Native actions use Mako's
host policy and the separately installed, patched Cua executable over MCP.

Cua supplies macOS accessibility, window identity, targeted input, capture and
Linux AT-SPI/X11/Wayland backends. Our release patch contains the lossless-value,
settling, keyboard, focus and recording changes. Removing the executable means
replacing those implementations and repeating their platform acceptance. The
user confirmed retaining it on 2026-09-22.

The upstream npm SDK was a different native implementation, selected only by an
experimental environment variable and benchmark option. It bundled an unpatched
0.28.1 dylib despite the installed +mako.12 executable. The selector, adapter,
benchmark option, dependency and lockfile entries have been removed. No provider
loses the shared MCP route. Cua's Rust SDK inside the executable is still used;
removing the npm SDK does not remove that internal Rust library.

## Browser transports

Regular Chromium profiles use the extension. Automatic scanning for
`DevToolsActivePort` has been removed, including its discovery module and tests.
This removes a second regular-profile route and its periodic directory scans.
Direct CDP remains for explicit Electron app routes, Mako's hidden desk windows,
and explicitly supplied cloud/test browser endpoints. It is not an automatic
fallback when the extension detaches.

## Build hygiene and target gates

`scripts/prune-host-output.mjs` removes compiler outputs whose TypeScript source
has been deleted before host/full builds. Source maps are excluded at the root of
the electron-builder file configuration: filters on external staging FileSets
alone do not exclude dependency maps. The package audit checks the actual ASAR
and resources for the retired SDK, wrong-platform native packages, Python caches
and source maps, verifies target-specific recording executables exist, and writes
`package-size.json` with total file bytes and the largest contributors.

The Mac packager stages only the selected Kiri and media architecture. It still
performs input hashing, signature verification, import checks and cold startup
tests. Generated Python bytecode, FFmpeg builds and source archives are ignored;
source manifests and build recipes remain tracked. Media source/license artifacts
are included in the distribution, not discarded to reduce its size.

| Target | Evidence and packaging status |
| --- | --- |
| macOS ARM64 desktop | Signed app recipe, bundled media, startup and archive recording checks. Patched native executable is separately installed. |
| macOS ARM64 native | +mako.12 signed and installed for new launches; 375 unit tests and scoped gesture/capture acceptance. |
| Linux ARM64 native | +mako.12 packaged; 448 unit tests; X11, GNOME 46 and Sway acceptance. GNOME helper ships beside driver. FFmpeg still comes from the runtime image. |
| Linux x64 native | Explicit architecture selection and separate Cargo cache implemented; no x64 acceptance claim. |
| Linux desktop / Intel Mac / Windows desktop | Generic electron-builder declarations are not release evidence. Complete target-specific native/media bundling and acceptance are missing. |

Linux packaging requires `--arch=arm64` or `--arch=x64`, applies the pinned patch
to an immutable archive, checks the image's actual architecture, and keeps Cargo
target volumes separate. `--image=` names the matching build image. The existing
Linux development image contains build tools, Chromium and test desktops; its
size is not the size of the shipped native executable.

## Further work

The native executable still links upstream browser helpers, policy evaluation,
overlay/PiP, update/skills and telemetry code. Telemetry and the live overlay are
disabled by Mako. These are candidates for an explicit embedded build profile,
not proven dead code: platform input and recording still cross shared core/SDK
modules. Measure dependency/section size and test the reduced executable before
removing them. Do not weaken authorization or input verification to shrink it.

Other measurable package contributors include the provider-owned Claude runtime,
Cursor SDK, Electron, sharp/libvips, and two esbuild binary locations. They have
live callers; reductions need provider/canvas checks. This audit does not delete
provider runtimes or user release backups.

Full installed-host replacement must wait for its active processes to exit. A
new extension worker and isolated shared-host acceptance do not mean the running
desktop host has been updated. Physical IME/concurrent typing, general proactive
Mac focus interception, remaining gesture routes and broader compositors remain
separate acceptance requirements in the wayfinder.

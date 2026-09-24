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
| macOS ARM64 native | +mako.17 signed and installed for new launches; background settling/recording and three system-activation recovery trials pass. Existing daemons were not restarted. General proactive focus protection remains open. |
| Linux ARM64 native | +mako.17 packaged with portal input/helper 10; four Sway scale/rotation/load workflows and forty hidden jobs pass. Earlier +mako.14 covers eleven transforms/scales. Prior GNOME/libei acceptance remains scoped to GNOME 46. FFmpeg comes from the runtime image. |
| Linux x64 native | +mako.17 packaged; 30 exact-value jobs, 400/400 synthetic concurrent keystrokes and X11 gesture/recording/interruption acceptance pass under translation. Native Intel Xeon acceptance now passes on EC2: thirty jobs, 400/400 synthetic concurrent keystrokes, X11 gesture/recording and interruption retention. AMD and x64 Wayland remain untested. |
| Linux desktop / Intel Mac / Windows desktop | Generic electron-builder declarations are not release evidence. Complete target-specific native/media bundling and acceptance are missing. |

Linux packaging requires `--arch=arm64` or `--arch=x64`, applies the pinned patch
to an immutable archive, checks the image's actual architecture, and keeps Cargo
target volumes separate. `--image=` names the matching build image. The existing
Linux development image contains build tools, Chromium and test desktops; its
size is not the size of the shipped native executable. Final +mako.17 executable
file sizes are 32,006,448 bytes (Mac ARM64), 47,732,752 bytes (Linux ARM64), and
51,052,608 bytes (Linux x64). Source and executable hashes are retained in the
[acceptance artifacts](audits/2026-09-23/local-control-focus15/packages17.json).
The native Linux packages include the helper and license; these figures are
executable bytes, not full desktop-app or container-image sizes.

## Reusable package boundaries

See [LC-28](local-control-map.md#lc-28--reusable-packages-and-public-entrypoints)
and the [source audit](package-boundaries.md). The current standalone runtime
assembles a tested application payload; an independently importable Node engine
with clean-install type/worker/media checks remains a separate work item.

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

The +mako.14 continuation records target-specific binary hashes and sizes in
[audit provenance](audits/2026-09-23/local-control-focus14/packages.json).
It adds no runtime package dependency for output geometry or image transforms.

+mako.17 adds no runtime dependency for focus recovery or drag pacing. Compared
with +mako.14, the Mac executable is 72,640 bytes smaller; Linux ARM64 grows by
78,048 bytes and x64 by 37,632 bytes. These are measured artifact differences,
not a claim of general runtime speedup. Focus interruption details appear only
when a change is observed; normal actions acquire no screenshot or extra poll.

The [cloud runtime design](local-control-runtime.md) separates the Node control
service from the Electron desktop host. The native acceptance payload contains
no Electron or provider runtime. Its test-only runtime image measured 1.44 GB;
this is not a shipped cloud release or the size of Mako’s desktop app.

## Standalone service package (2026-09-23)

`runtime/control` supplies an exact public npm lock and separate browser/native/mixed
image targets. `scripts/package-control-runtime.mjs` copies the compiled Node
entry-point graph plus the dynamic program worker, licenses and only the selected
reviewed driver. It excludes Electron, provider runtimes, caches, bytecode,
credentials and unrelated source. Package boundaries and hashes are regression
tested. FFmpeg is supplied by the runtime image, not copied into source control.

Initial ARM64/x64 packages contain 66 files and 48,304,040 / 51,623,865 bytes,
including the platform-specific native driver. Capture21 adds one shared capture
module; its packages contain 67 files. These numbers exclude npm dependencies and
OS image layers, so they are not total installed sizes. See the runtime guide and
exact release manifests. Initial native ARM64 and Intel x64 lifecycle acceptance
passed; the capture21 evidence identifies subsequent tested builds separately.


## Reusable Node package extraction

LC-28 now ships source packages `@mako/control` and `@mako/control-runtime`; the
Linux deployment recipe installs those same packages. The CLI, task supervisor and
application share their engine. Archives include declarations and licenses, omit
maps/caches/binaries, and pass a strict external-consumer check. Desktop packaging
omits package declarations. Docker installs complete prepared packages before
creating CLI links. See [measured sizes and acceptance](local-control-package-evidence.md).
Full native/mixed image totals, the newly packaged desktop and publication remain
separate gates; the small npm archives do not represent installed Chromium size.


## Recording media recipe 2

The streaming renderer requires FFmpeg's `pipe` protocol and `rawvideo`
demuxer/decoder. The macOS ARM64 recipe enables those explicitly while preserving
static linking, disabled networking/autodetection and the same pinned sources.
The packager now compares source manifests and recipe versions, in addition to
binary hashes, so a valid old binary cannot ship with an incompatible renderer.
Rebuild with `npm run prepare:control-media`; generated binaries stay ignored.
The existing packaged recording test runs with Homebrew removed from PATH and
checks both browser encoding and native transparent cursor composition.

## September 24 source-rate candidate

`0.28.2+mako.19` adds requested native capture rates, a CoreGraphics first-use
preflight and writable-pipe waits on Linux. Mac ARM64 and Linux ARM64 packages
match the reviewed patch; they are acceptance candidates, not an installed
upgrade or x64 proof. The selected installed driver remains +17. The new API
reads backend rate capabilities rather than assuming 60 fps on every platform.
No new runtime capture dependency was added. The [backend reuse plan](local-control-capture-backends.md)
tracks the larger PipeWire/DMA-BUF work and its target-specific dependency budget.

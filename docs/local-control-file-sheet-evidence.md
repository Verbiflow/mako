# AppKit file-sheet acceptance, September 24

Native driver `0.28.2+mako.21` is signed and installed for new launches. Existing
daemons were not restarted. The CLI selected the exact scratch file and confirmed
it in a real background NSOpenPanel. This closes that route, not all Mac dialogs.
The desktop application remains build `345bfd91c64009c6`.

## Cause and change

AppKit exposes the panel as an AXSheet inside the parent AXWindow, with its own
CGWindowID. It omits that sheet from AXWindows. The sheet's AXWindow attribute
points back to the parent. Previously the panel had no resolvable observation;
using its Cancel control through the parent correctly failed exact-window checks.

Observation and input validation now share bounded window/sheet discovery. It
compares native identities, deduplicates AX proxies and releases retained objects.
A sheet uses its own native window ID. Discovery is limited to 64 windows/sheets,
256 immediate children per window/sheet and 500 ms within the outer read deadline.
Missing roles, incomplete discovery and unresolved ownership refuse input. No
matching by title or geometry, parent-ID substitution or new dependency was added.
Sheet observations exclude sibling windows and the application menu bar.

## Direct checks

`scripts/test-native-file-sheet.mjs` freezes the compiled CLI runtime and selects
an explicit driver when MAKO_TEST_DRIVER is supplied. Its four rounds independently
verify three Cancel responses and one exact file selection/confirmation. The
selected filename comes from AppKit's completion handler. The duplicate file and
parent Save control stay untouched. Cross-window and closed-sheet references are
rejected before dispatch; an uncertain opening AXPress is never replayed.

The final signed candidate and installed-driver repetition both pass all four
rounds with unchanged foreground notifications. Reads/actions emit no images.
Earlier +20 prototype passes are retained separately. A +19 baseline fails at the
panel observation, before input. Some runs failed when another app became active;
those failures remain in the evidence. The menu failure coincided with a separate
packaged lifecycle test activating its own Mako process, identified by PID and
command line. A subsequent menu run passed all three selections without activation.

The final driver also passes background settling, click/right/middle/double-click
and scroll, with exact independently received coordinates. Its 901-frame recording
has 19 pointer events, no dropped frames, decodes fully and shows the cursor at the
tested location. Background drag remains refused. This small fixture recording is
not a new 1080p capture-rate benchmark.

Pinned Rust 1.97.1 Mac tests: 377 passed, two ignored. Driver installation tests
cover replacement, rollback receipts, concurrent admission and rejection of invalid
packages. Final full repository lint passes with five existing warnings. An earlier
lint run failed on concurrently edited provider files; its failure is retained.
An accidental build from outside the nested Rust workspace selected Rust 1.93.1;
it was stopped, and its results are excluded from release acceptance.

## Limits retained deliberately

The panel observation reports incomplete coverage. A read-only AX probe finds
generic failures for six image descriptions, one outline value and a splitter's
action list. These errors are not ignored to manufacture complete coverage. The
tested workflow uses explicit observed references; strict whole-panel locator
uniqueness is not established. This initial run did not cover ViewBridge panels or Save As. The
[later continuation](local-control-dialog-depth-evidence.md) proves sandboxed
Open/Save semantic workflows. Arbitrary paths and raw sheet keyboard/pointer
delivery remain separate gates.

The exact sheet binding is shared across input routes, but an unknown minimized
state still prevents routes that require proving it. Semantic actions do not
silently enable unrestricted background keyboard delivery.

A proactive focus experiment read and temporarily attempted only the activation
bits on disposable windows, restoring the prior bits. Set returned success, but
readback never changed, even for an owned-window control. That is insufficient
evidence for a prevention mechanism; no such change shipped. The diagnostic's
own AppKit setup also activated its process in one run. Existing focus recovery
remains reactive. Physical typing attestation and actual IME composition still
require participant coordination; no synthetic event counts as physical input.

The new Mac package adds no dependencies: its executable is 32,010,928 bytes,
versus 32,012,352 bytes for +19. This small size difference is not a performance
claim. Linux acceptance remains on +19; +21 is not a newly accepted Linux build.

Repeat from the repository root with `node scripts/test-native-file-sheet.mjs`.
Use `MAKO_TEST_DRIVER=/absolute/path/to/cua-driver` to test a candidate without
changing the installed selection. Menu, settling and human-input runners accept
the same explicit driver and freeze their package code for the run.

Raw receipts, failures, fixture state, AX diagnostics, provenance and media are in
`docs/audits/2026-09-24/local-control-native-parity/file-sheets/` (gitignored).
See [Wayfinder](local-control-map.md#lc-24--native-accuracy-and-background-behavior)
for the remaining work.

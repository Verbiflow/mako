# Native dialog and bounded-read continuation, September 24

Sandboxed Open and Save As now pass complete CLI workflows using installed
Mac driver +mako.21 and a frozen copy of the updated source engine. The source
engine changes are not installed-desktop acceptance. No driver update was needed.

## What failed and changed

A real sandboxed AppKit file dialog exposes a separate
`com.apple.appkit.xpc.openAndSavePanelService` process in its accessibility tree.
The tests discover that PID from the exact panel subtree and check its executable
while the panel is open. They retain the panel's native window identity and use
its observed refs. They never substitute the service PID for the app/window pair.
Apple documents the separate-process panel design in
[NSOpenPanel](https://developer.apple.com/documentation/appkit/nsopenpanel) and
[App Sandbox file access](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox).

The expanded Save panel revealed a read-budget failure: depth-first traversal
used 1,000 nodes on directory columns before reaching Save and Cancel. Raising
that budget would spend more time reading unrelated file lists. The public native
API now accepts `window.observe({maxDepth:5,max:250})`. It forwards the explicit
depth limit to the native driver and records it in `scope.maxDepth`. Window handles
have a typed option; browser targets reject it. Drivers without that advertised
capability refuse before dispatch. Help and the API guide describe the option.

This does not convert a partial tree to a complete one. When descendants are
omitted, coverage remains incomplete and cannot establish absence or whole-tree
uniqueness. Explicit observed refs remain actionable under the existing ownership
and stale-reference checks. Read-only observations produce no screenshots.

The same tests also reproduced a startup failure when a long, canonical temporary
path exceeded macOS's Unix-socket path limit. Shared runtime allocation now checks
UTF-8 bytes, reserves space for nested sockets and gives long metadata paths a
separate random, owner-only short socket directory. The session descriptor carries
the real socket path. Desktop/cloud runtime roots stay short enough for their
children; their existing owners still remove the whole root after crashes.

Short endpoint cleanup runs on startup failure, stop and exit. A bounded,
nonblocking scan can reap a dead owner's abandoned endpoint on a later launch.
It checks directory/socket ownership, refuses symlinks or unexpected contents,
skips live owners and sockets that still accept connections, and never recursively
deletes an unverified directory. It considers at most 128 matching entries and stops scheduling new checks
after a 25 ms scan budget, with a 10 ms connection-probe ceiling. Uncertain leftovers
are retained. No global Docker/cache pruning or new runtime dependency was added.

## Acceptance

- Sandboxed Open: three Cancel rounds and one exact file selection. Sandboxed
  Save As: three Cancel rounds, filename edit and confirmation, then an independent
  filesystem content check. Both final runs confirmed Apple's remote panel service,
  kept foreground notifications unchanged, left the decoy and parent Save untouched,
  and rejected cross-window and closed-panel refs before dispatch.
- Expanded Save reads returned 83–84 lines. Five reads in the final run had a
  244 ms median and 666 ms maximum, including CLI transport. Open reads had a
  526 ms median and 921 ms maximum. These are scoped measurements, not a paired
  performance benchmark or a general latency promise.
- labwc 0.8.3, Weston 14.0.2 and KWin 6.3.6 each passed depth-limited reads followed
  by twenty background form jobs, exact saved values, untouched decoys and stable
  focus histories. Omitted descendants stayed incomplete. Unverified raw input
  and capture still refused. These runs used the previously packaged Linux +19
  driver on ARM64, with the current shared engine, not a new Linux driver build.
- Socket tests passed long Unicode paths, distinct live sessions, owner-only modes,
  repeated close, startup failure, long-TMPDIR worker/parent crashes, dead-owner
  cleanup and preservation of live endpoints and unrelated files.
- Core tests, engine regressions, package relocation/public imports/types, startup
  cleanup and full lint passed. Lint retains five existing warnings. Packed public
  packages are about 60 KB and 134 KB compressed; that excludes their dependencies
  and is not a full app-size claim.

The Linux matrix reused the existing compositor image and a frozen payload with
cloned dependencies. All three labeled test containers were removed afterward;
no image was built. The tested payload has its own hashes and explicitly names
its older +19 driver. It does not relabel an old driver as +21.

## Retained failures and limits

The first socket attempt failed before a native observation. One compact Save
panel exposed no second-process AX node, so that attempted cross-process check
failed. Expanding it exposed the service. The next check failed because the test
expected the wrong capitalization in the executable name; that was corrected to
the observed exact system basename. The expanded read then failed to reach Cancel
under the unchanged 1,000-node limit, motivating the explicit depth option.

Two later full-focus trials saw other processes become active and failed. Those
PIDs had exited before they could be identified; their cause remains unresolved.
The fixture now records the activation event's app name and bundle ID as well as
PID, without collecting keys or window content. The final quiet repetitions pass;
the failed runs remain in the evidence. A socket assertion initially read the raw
protocol result as a CLI-formatted block; the corrected test parses the actual
text block. An initial lint failure was fixed without disabling its rule.

These results establish semantic Open/Save actions through AppKit's remote panel
proxies. They do not establish arbitrary cross-process raw key/pointer delivery,
general proactive prevention of an application's deliberate activation, physical
IME or human typing, or new compositor gesture/capture routes. Coordination
questions for the physical tests remain unanswered. Incomplete AX descriptions
and values remain explicit failures of full coverage.

Repeat with `node scripts/test-native-file-sheet.mjs --sandbox` and
`node scripts/test-native-file-sheet.mjs --sandbox --save`. The optional
`MAKO_LOCAL_SIGNING_IDENTITY` chooses the local fixture signer; the tested runs
used the existing local certificate. Ad-hoc sandbox signing is a fixture option,
but was not validated in these runs. `MAKO_TEST_DRIVER` selects an absolute
candidate executable without changing the installed default.

Raw receipts, failures and source/payload hashes are retained in
`docs/audits/2026-09-24/local-control-native-parity/dialog-depth-continuation/`
(gitignored). [Wayfinder](local-control-map.md#lc-24--native-accuracy-and-background-behavior)
owns the remaining gates and deployment status.

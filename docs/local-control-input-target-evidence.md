# Native field targeting and gesture continuation, September 24

The shared engine dropped the addressed field when a native `pressKey` included
modifiers. `window.locator(...).pressKey('Left',{modifiers:['Shift']})` resolved
the correct ref, but the hotkey branch omitted it from the driver request. The
key could reach a different field already holding focus in the same window.

The engine now forwards the ref for both plain and modified keys. The driver's
existing exact-window validation and field-focus route stay in charge. A driver
without advertised field addressing refuses before dispatch. No new native
binary, dependency, observation or screenshot is required by the fix.

## Before and after

`scripts/test-native-keyboard-target.mjs` launches a disposable AppKit window
with two text areas. Before each modified key, it focuses the decoy through the
CLI. The target contains `abcdef`; the decoy contains `leave this untouched`.
Independent AppKit state records which field owns focus, both selection ranges,
text and application-activation notifications.

- The frozen engine from the prior dialog run failed: Shift+Left selected the
  last character in the decoy. The requested target's selection stayed unchanged.
  The failed run is retained.
- The updated source engine passed three selections. Each Shift+Left extended
  the requested field's selection, left the decoy's text and selection unchanged,
  and produced no foreground change.
- Signed candidate `0d02dc53d0a315ff` passed the same three rounds using its actual
  ASAR engine, CLI worker and Electron executable. Both tests used installed
  Mac driver `0.28.2+mako.21`.
- The packaged modified-key calls took 1,396–1,437 ms including one observation,
  CLI invocation and native settling. This establishes correctness, not a latency
  improvement or a general performance promise.

The engine regression checks one observation and one dispatch with no image,
exact PID/window/ref forwarding, stale-ref refusal and refusal before an old
backend actuator runs. Browser key delivery was not changed.

## Public middle-click

The public native `click` implementation also rejected every middle-click even
though the native driver supports it. A single middle-click now uses the driver's
explicit `button:'middle'` route. Drivers without that advertised option refuse;
there is no fallback to left-click. Repeated right/middle clicks and triple clicks
remain unsupported.

The real settling/gesture test now exercises middle-click through the public API
with a screenshot resized to 300 pixels, its current view token and converted
fixture coordinates. AppKit independently received middle-button events. The
recording finished with 671 frames at 600×352, 19 retained pointer events and no
reported frame drops. All 148 foreground samples remained on the original app;
the fixture recorded no activation notifications and no held mouse buttons.
This is a small-window correctness run, not the 1080p60 performance gate.

The first gesture attempt used an AX Group without an actionable ref. The API
correctly refused the undefined target before dispatch. The test now uses the
screenshot route appropriate for that canvas; no ref is invented and no policy
was relaxed. The failed attempt is retained.

## Release and verification

The candidate is signed with the existing local identity and is 662,964,259 bytes
installed. Its frozen package contains 1,095 verified build files and 688 resolved
host imports. Both packaged startup routes, shared-host reuse, Quit/reopen and
draft persistence pass. CLI checks confirm private session ownership, shared
state across shell processes, code identity, cleanup and absence of the public
Local Control MCP adapter. Bundled browser/native cursor encoders pass with
Homebrew excluded from PATH.

Source engine regressions, public package/relocation/cleanup checks, TypeScript
and full lint pass. Lint retains the same five existing React Compiler warnings.
The runtime archive is 133,836 bytes compressed; this excludes dependencies and
must not be confused with the installed app size above.

The current installed desktop is separate from this candidate. Readiness found
running Mako processes, so no app was replaced and no installer was left queued.
The candidate includes the preceding bounded-read and private-socket changes.
Its dialog acceptance result is recorded alongside the other packaged receipts.

## Remaining gates

These fixes do not establish proactive prevention of deliberate application
activation, arbitrary raw keyboard/pointer routing across remote panel processes,
IME composition, additional Linux compositor gestures, or full reference parity.
The earlier English typing trial remains evidence; the user confirmed that it was
already performed, so it was not repeated. IME remains a distinct participant
choice; Japanese is not mandatory. No synthetic key sequence is counted as a
physical or composition test.

Run `node scripts/test-native-keyboard-target.mjs` for source-engine acceptance.
For a candidate, use its executable with `ELECTRON_RUN_AS_NODE=1` and pass
`--app /absolute/path/to/Mako.app`. `MAKO_TEST_DRIVER` selects an explicit native
binary; `MAKO_TEST_RUNTIME` selects an absolute frozen runtime for before/after
checks without replacing any installed component. `scripts/test-native-settling.mjs`
covers the public middle-click recording route.

Raw states, failures, media, build receipts and source hashes are retained under
`docs/audits/2026-09-24/local-control-native-parity/input-target-continuation/`
(gitignored). [Wayfinder](local-control-map.md) owns deployment and next work.

# Recording backlog and native cursor fixes

September 25, 2026. Current release gates belong to [Wayfinder](local-control-map.md).
This follows the failures in [installed media acceptance](local-control-installed-media.md).

## Native cursor propagation

Right-click and double-click dispatched real pointer events inside ordinary Tokio
blocking workers. Those workers lost the task-local recording scope. The input
succeeded, but its dispatch points never reached the shared recording timeline.
The action routes now use the existing recording-aware blocking helper. Read-only
AX introspection remains unchanged. The core propagation regression covers both
gestures.

The signed Mac driver is `0.28.2+mako.22`, based on pinned upstream
`fc188250b4ca8549b8e61f937fdb1fb560770e86` plus the repository release patch.
At that checkpoint it was selected for new launches. Existing host daemons were not restarted:
a new proxy executable can still connect to an old `+mako.21` daemon.
Installed-host acceptance therefore remains separate from the private-driver test.
The installed bundle and running host PID 48904 both report build
`48bf10dc948aa13c` (built 2026-09-25T09:02:53.280Z), which predates these fixes.
The earlier installed-media report refers to its own `9b696b0d9525e7e9` checkpoint.

`scripts/test-native-pointer-recording.mjs` starts its own signed driver and
AppKit fixture, borrows the shared SDK, and freezes the runtime used by that job.
The first passing run retained exact whitespace/Unicode text, three right-click
and five double-click dispatch points, eight shared timeline points, and a decoded
cursor with its press ring. The 480×232 native recording contained 264 source frames
across 4.56 seconds. The fixture never became foreground in 60 samples. This proves
the affected dispatch routes, not native 1080p throughput or physical human typing.

A later rerun retained all eight cursor events, exact values and the decoded stroke
and ring, but failed foreground acceptance: the fixture appeared in 44 of 58 samples
(the other 14 named Mako). That sampler did not retain phase timestamps, so it cannot
distinguish launch-time activation, input-triggered activation or physical user
interaction. No cause is claimed. The next run added foreground readings at fixture
startup and around every SDK call; it passed with Aside foreground in all 59 samples.
This is cursor-fix evidence with an unresolved foreground counterexample, not a
claim that general proactive focus prevention is solved. Both reports are retained.


## Browser encoder work

Continuous browser recording now sends RGB24 rather than RGBA to FFmpeg: 6,220,800
rather than 8,294,400 bytes per 1080p frame. It removes an unused alpha channel,
reducing raw pipe traffic by 25%. Cursor composition uses libvips on the clipped
artwork rectangle rather than converting every pixel in the full image for a
28×32 overlay. Native transparent overlays retain the original full-frame alpha
path.

An independent full-frame compositor oracle checks exact RGB equality on patterned
pixels, overlapping cursor/ring artwork and clipped edges. The encoder still uses
VideoToolbox quality 85, YUV420P, no software fallback, the same frame rate and the
same queue/lag bounds. Explicit screenshots are unchanged. Bounded once-per-encoded-
second timing records distinguish render work, pipe admission and scheduling lag.

## Measurement scope

Browser runs use the regular Aside Work profile through the installed extension,
a source-built shared host, and two production preview viewers in an offscreen
Electron fixture. They are not installed desktop-host acceptance. Input latency
ends at the offscreen compositor, not physical scanout. Other user applications
remain active; machine load varies. Whole-browser resource figures include all
browser processes. Summed RSS may count shared pages more than once, and GPU/media
engine energy is not measured.

The final ordinary 60-second run completed: 57.71 distinct preview fps and 58.50
distinct recorded fps at 1920×1080. All 36 exact inputs and both screenshot-pixel
checks passed; no invalid motion-marker frames. Host plus encoder used 1.20 CPU
core equivalents and 444.6 MB peak summed RSS. These source-host totals must not be
presented as a matched reduction from the busier installed host.

Two consecutive final 120-second trials with two SHA-256 load workers passed:

| Metric | First loaded pass | Repeat |
| --- | ---: | ---: |
| Distinct preview fps | 58.07 | 57.18 |
| Distinct recorded fps | 57.90 | 57.29 |
| Maximum encoder scheduling lag | 95 ms | 234 ms |
| Host + encoder CPU equivalents | 1.22 cores | 1.20 cores |
| Host + encoder peak summed RSS | 442.2 MB | 443.7 MB |
| Click/type/scroll input-to-visible p95 | 74/76/74 ms | 71/64/85 ms |

Both recordings finished, all 36 exact input checks and both screenshot comparisons
passed, and decoded motion markers contained no invalid frames. Closing both viewers
preserved recording until explicit stop. Machine load averages began at 6.68/7.06 and
ended at 12.37/17.35 on 14 logical CPUs. The first pass includes a three-second,
read-only FFmpeg process sample; the unsampled repeat also passes. These results
meet the accepted sustained 55-fps floor for this fixture. They do not guarantee
throughput under arbitrary machine contention or certify the still-running installed
host. Retain the first/repeat reports as `loaded-final/` and `loaded-repeat/`.

Earlier loaded trials remain counterevidence. A two-minute desk recording finished
but delivered only 50.16 distinct preview fps and 52.94 recorded fps. Aside trials
interrupted at 23.29 and 54.44 seconds. The latter kept pace for roughly 48 seconds,
then pipe admission slowed and the encoder reached the unchanged two-second lag
limit. This is not evidence of a steadily drifting media clock.

An NV12 output experiment passed the isolated text-quality comparison but failed
the live load job after 3.85 seconds. It was rejected; production remains YUV420P.
An intermediate compile-error run and a run whose source identity changed during
measurement are invalid and excluded from acceptance. No power-management change
was adopted from those runs.

Raw local evidence is under ignored `docs/audits/2026-09-25/media-fixes/`.
Keep reports, timelines, media and process samples; do not copy session descriptors.
The scripts and this report are the durable, shareable record.

## Verification

- Recording regression suite passes, including byte-exact cursor composition,
  transparent native overlays, stalls, worker failures and source-rate refusal.
- The continuous recording test passes 60 seconds, real encoder termination with a
  decodable retained prefix, and unchanged native pass-through bytes.
- Final RGB24/YUV420P quality probe decodes 240 frames per encoder at 1920×1080.
  Hardware text-region MSE is 3.03–3.08 versus 3.52–4.88 for the software policy at
  all six checked positions. This is fixture reconstruction evidence, not OCR or
  a universal quality claim. The production quality setting remains 85.
- The core Rust blocking-worker propagation test passes for right/double click.
  The signed candidate's exact release patch matches the built worktree
  (SHA-256 `85f0b9b90e1c75f6b4254b0bdeae4cc08b5ddad9d15e79679227ab133de6bf78`).

## Release boundary

Full `npm run lint` passes with zero errors and five existing React warnings;
Oxlint and actionable-toast checks pass. `npm run build` passes its TypeScript,
renderer, host and extension lanes. Driver patch/worktree equality and script
syntax checks pass.

Signed desktop candidate `16c797db97b714df` contains these changes:
`release/media-fixes-20260925/mac-arm64/Mako.app`, built at
2026-09-25T10:12:29.262Z. Packaging verified 1,116 frozen build files and 719 host
imports. Both packaged startup routes, signature verification and bundled
browser/native recording checks pass with Homebrew excluded from PATH.

An installer monitor observes the existing idle quit without replacing or cancelling
that request. It uses the standard installer and startup verifier, aborts if the
host changes or the quit is cancelled, and expires after 30 minutes without force-
stopping processes. Its receipt is
`release/media-fixes-20260925/install-state.json`. After installation it runs bundled
recording checks. It explicitly leaves **live installed sustained browser acceptance
and installed native cursor/focus acceptance** open; those checks are not implied by
a successful package or a new proxy executable. At that checkpoint installation was
queued, not completed. That monitor subsequently aborted safely when the host
changed; see the follow-up below.

## Reproduction

Build the shared runtime before the media checks. Run performance jobs alone;
builds, lint and other encoders can invalidate comparisons. Use the browser ID
returned by discovery and its actual root PID; never silently substitute a browser.

```sh
npm run build:control-runtime
npm run test:control-recording
npm run test:control-recording-continuous
node scripts/audit-control-video-encoding.mjs --input-format=rgb24 --pixel-format=yuv420p
node scripts/audit-control-preview.mjs --shared-host --extension="$BROWSER_ID" \
  --two-viewers --recording --seconds=120 --load-workers=2 --browser-pid="$BROWSER_PID"
ELECTRON_RUN_AS_NODE=1 /Applications/Mako.app/Contents/MacOS/Mako \
  scripts/test-native-pointer-recording.mjs
```

The native check defaults to the exact signed release candidate named by
`vendor/cua-driver/release.json`; it does not silently select a different driver
from PATH. Rebuild that candidate from the pinned patch before running it on a
fresh checkout. The installed permission host and macOS grants must be available.


## Installed follow-up: September 25

The earlier monitor did not install candidate `16c797db97b714df`: its receipt says
“Host changed while waiting; nothing installed.” The current default host is build
`48bf10dc948aa13c`, PID 66645 at inspection. Its native daemon PID 67702 actually maps
to the signed `+mako.22` executable, verified with `lsof`; do not infer the daemon's
version from the newer proxy or symlink.

The update CLI could also wait indefinitely on orphan crash reporters after its
host exited. It now uses the same exact-bundle helper cleanup as the in-app
installer. Socket disappearance alone is insufficient: the authorized host PID
must return ESRCH. Live hosts and permission-denied probes cannot trigger cleanup.
Helpers must still pass the existing user, parent, executable and rechecked
identity rules. Both installer suites pass these cases.

### Native evidence and idle-session regression

Two runs borrowed the actual installed task session and passed exact text,
right/double-click dispatches, eight cursor timeline points, decoded cursor/ring
and foreground checks. A third discovery call was rejected before input because
its still-running proxy's implicit session had been idle-evicted. The shared SDK's
five-minute sweep had lost the live control-connection lifetime rule.

`+mako.23` restores that rule with a runtime-scoped transport lease owned by the
persistent connection, on both Unix and Windows daemon branches. Only implicit
sessions are exempt from idle expiry while connected. Named-session TTL, explicit
end/revocation and connection-close cleanup remain effective. There is no automatic
revival, heartbeat or action replay. Core lifecycle and adapter regressions prove
these distinctions, including duplicate lease cleanup and isolation from another
transport owner. The real proxy check uses a private daemon with a one-second TTL
and waits 35 seconds across its actual maintenance sweep before reading again and
completing the native recording job.

The AppKit fixture previously called `orderFrontRegardless()`, which raises a window
without necessarily activating its app. It now calls `orderBack(nil)` and records
bounded, timestamped activation/mouse events alongside the sampled foreground PID.
See Apple's [ordering documentation](https://developer.apple.com/documentation/appkit/nswindow/orderfrontregardless%28%29).
Three isolated and two installed-session background runs passed with Aside active.
After the user offered a Mako-focused check, the actual measurement instead found
Dock (PID 59282) foreground for all 68 samples. That run passes background cursor
and value checks, **not Mako-focused acceptance**. The original foreground failure
remains unexplained; changing fixture ordering does not prove general proactive
focus prevention. Physical IME remains declined.

### Signed-package media checks

`audit-control-preview.mjs --runtime-app=/absolute/Mako.app --shared-host` now
executes the signed package's host and media modules in an isolated host. Reports
record that scope explicitly; it is not the default desktop task host. The same
production preview UI, exact input/pixel oracle and frame-rate floors apply.

One signed-package run resized the source viewport mid-recording and failed input
and pixel checks; the cause remains unresolved. A new pre-input viewport assertion
refuses that invalid fixed-resolution fixture instead of producing misleading
pixel results. The next 30-second run preserved 1920×1080, all 36 exact inputs and
both screenshot comparisons, and finalized at 55.27 distinct recorded fps. Preview
reached 54.66 fps and **failed the unchanged 55-fps floor**. Click/type/scroll p95 was
104/158/90 ms. These failures remain evidence; the prior source-host passes do not
supersede them.

Follow-up evidence is under ignored `docs/audits/2026-09-25/installed-media-followup/`.
Session descriptors and private credentials are excluded. Candidate
`1fb3bfb7b3d14e96` (`release/media-followup-20260925/mac-arm64/Mako.app`) contains the
installer and media changes; packaging verified 1,116 files and 719 imports and
both startup routes. The driver is released separately. Installed acceptance must
name the bundle, host and actual daemon independently.


### Follow-up validation and queued rollout

- All 19 core lifecycle tests pass, plus the adapter regression that keeps an
  implicit session alive across a zero-TTL sweep and ends it on transport close.
- The real signed +23 proxy/daemon passes a 35.29-second idle pause with a one-second
  configured TTL, then exact text, native gestures and cursor/ring recording.
  All 284 sampled foreground readings identify Aside; no fixture activation event.
  An earlier attempt successfully read after idle but its overly broad equality
  assertion rejected unrelated z-order movement. The check now compares exact
  fixture process/window identities; both attempts are retained.
- +23 is signed and selected for new launches. The active default daemon remains
  +22 until its owner exits. Patch/worktree/package provenance match:
  `e3ae87a43a17c07f624504d12c5516f427cde50d7e599d7dc65928139213f94a`.
- Signed candidate `1fb3bfb7b3d14e96` passes real MCP transport reconnect, docs/state
  recovery, acknowledged-action interruption without replay, stale-handle refusal,
  Aside exact save/dialog/screenshot and native exact-value/screenshot/background
  checks. These execute candidate ASAR modules in an isolated acceptance host.
  Bundled browser and native hardware recording also pass with Homebrew excluded.
- Full lint passes with zero errors and five existing React warnings. Final
  installer suites, native-test lint and patch/signature checks pass.

Monitor PID 56055 observes the existing quit request without replacing or cancelling
it. It waits up to one hour for active agents; the current conversation and another
session were active at queue time. Confirmed host exit enables the shared exact-
bundle helper cleanup. A changed host, cancelled quit, deadline or install lock
aborts safely; no active agent is force-stopped. It installs the verified candidate,
checks the restarted default host build and runs each installed acceptance job,
including a 120-second two-viewer recording measurement. Each child check has a
five-minute deadline and its own log. A failed check does not skip unrelated checks.

[Live install receipt](../release/media-followup-20260925/install-state.json) and
[installer log](../release/media-followup-20260925/install-after-idle.log) record actual
completion. At this handoff the receipt is **waiting-for-idle**, not installed.
Fresh default-host task acceptance and the controlled Mako-focused reproduction
remain explicit gaps even if isolated installed-package checks pass.


The final 60-second **signed-candidate isolated-host** repeat passes: 58.05 distinct
preview fps and 57.55 distinct recorded fps at 1920×1080, with both viewers open.
All 36 exact inputs and both pixel comparisons pass; no invalid decoded markers,
150 ms maximum recorded hold, and 334 unchanged Aside foreground samples.
Click/type/scroll input-to-visible p95 is 79/74/117 ms. Recording finalizes with a
62-second playable output. Host plus encoder consumes 1.62 CPU equivalents and
449 MB peak summed RSS; the encoder accounts for 0.26 CPU equivalents. This is
higher CPU than the earlier source-host runs and is retained without attributing a
cause or claiming a matched efficiency improvement. The fixture including viewers
uses 2.30 CPU equivalents/1.01 GB; those are distinct measurement scopes. GPU power
is not measured. The earlier 54.66-fps preview miss remains counterevidence.
Artifacts: `installed-media-followup/candidate-preview-60/`.


### Installation outcome checked after idle

The queued monitor reached idle, then failed at 2026-09-25T11:07:30.348Z because
another installer held `/Applications/Mako.app.update-lock`. The exclusive lock
prevented overlapping application replacement. Its receipt is `not-installed`
with an empty acceptance-check list; no post-install success is implied.

The subsequent status check found both `/Applications/Mako.app` and the running
host (PID 79196) on build `3c865f5347d339c7`, built at 09:48:42 UTC, rather than the
prepared `1fb3bfb7b3d14e96` candidate built at 10:47:10 UTC. The install lock is now
absent and no queued installer process remains. The exact competing install path
has not yet been attributed; do not claim the desired update completed or the
post-install tests ran.


### Full-workspace rebuild and retry (21:53 UTC)

The user explicitly requested the other contributor's local changes too. A fresh
`npm run package:mac:local` built the entire current workspace. A manifest of 1,907
tracked and untracked source files is identical before and after the build. Direct
ASAR comparisons verify the current Codex permission observer/app modules,
Codex and Claude live drivers, and local installer. No cherry-pick or selective
source copying was used. Full lint, access modes, permission observer, complete
live-approval regressions and both signed packaged startup routes pass.

The artifact is `release/combined-local-20260925/mac-arm64/Mako.app`, built at
21:51:28 UTC. Its code-content build ID remains `1fb3bfb7b3d14e96`; the earlier
candidate already contained these app changes. The fresh build proves inclusion
against the current working tree. [Combined build verification](../release/combined-local-20260925/combined-build.json).

Monitor 99356 is running with the standard idle quit and exclusive installer.
There was no competing installer or lock; the host reports this conversation as
the only active work. The old failure receipt is preserved. The new
[installation receipt](../release/combined-local-20260925/install-state.json) is
waiting-for-idle and records subsequent install/startup/acceptance outcomes.
The existing default host's native daemon already maps to +23; desktop code still
requires this replacement. Installation is not claimed before the receipt and
running host confirm it.


### Retry after identifying the host reopener

The combined attempt aborted at 21:54:38 UTC: default host 2165 had replaced 79196
before installation. `ps` identified its parent as development host 97651, running
since September 23. `shared-conversations.ts` calls `ensureRuntime` when a saved
conversation's owner socket is absent, which can race intentional replacement.
The installed bundle remained `3c865f5347d339c7`; no acceptance job ran.

The development host reported an empty lifecycle work list and idle operation. A
normal lifecycle quit closed it; its socket then stayed absent and default host
2165 was reparented to PID 1. No signals or forced agent stops were used. Source
hashes excluding documentation still match the complete combined build. Monitor
19143 retries that exact artifact after a development-host-absence preflight.
The failed attempt is preserved in `install-attempt-1.json`; the current receipt
is again waiting-for-idle. Cross-profile intentional-quit/wake coordination remains
a product follow-up; this operational mitigation does not claim to implement it.

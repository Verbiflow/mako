# Local Control wayfinder

Updated 2026-09-30. This is the current plan for browser and computer control across
all harnesses, desktop Mac and isolated Linux cloud jobs. The goal is accurate,
responsive complete workflows through a typed engine, agent MCP and composable CLI. Full ChatGPT/Codex
parity has not been established.

## Start here

- **What to do next:** [delivery order](#delivery-order) and the workstreams below.
- **Every complaint from the agent:** [issue ledger](local-control-agent-issues.md),
  including findings that were corrected, not reproduced, or remain open.
- **Architecture:** [ownership boundaries, diagnostics and change tests](local-control-architecture.md).
- **Agent discovery and MCP integration:** [LC-29](#lc-29--agent-discovery-and-mcp-integration) records passing installed Mac/Aside + Codex acceptance and remaining provider/platform coverage.
- **CLI refactor:** [shared engine and shell contract](local-control-cli.md).
  Prior CLI-only acceptance is historical; MCP-first integration supersedes that delivery choice.
- **Native capture reuse:** [source-reviewed open-source candidates and backend acceptance](local-control-capture-backends.md).
- **Interactive streaming:** [reference findings, transport experiments and local/remote scope](local-control-streaming.md).
- **Lightweight media:** [Capy, Replicas, Tembo, Synara and T3 review; hardware and low-delay software probes](local-control-media-prior-art.md).
- **Current fixes:** [native cursor propagation, RGB recording and sustained acceptance](local-control-media-fixes.md).
- **Current media investigation:** [continuous recording, encoder-crash evidence and ordered implementation gates](local-control-media-investigation.md).
- **Streaming choice and VNC:** [Selkies/pixelflux prototype, Moonlight comparison and compatibility boundary](local-control-streaming.md#september-24-selection-browser-streaming-moonlight-and-vnc).
- **Using the existing API:** [API reference](local-control-api.md).
- **Reusable packages:** [Node package ownership and consumer checks](package-boundaries.md); [LC-28](#lc-28--reusable-packages-and-public-entrypoints).
- **Build, cloud and contributors:** [runtime](local-control-runtime.md),
  [packaging](local-control-packaging.md), [CI](local-control-ci.md).
- **Earlier decisions, experiments and failures:** [history](local-control-history.md).
  Historical “pending” and “installed” statements are scoped to their checkpoint.

This file owns current workstream status. The issue ledger owns individual agent
complaints. Other documents hold contracts, recipes or evidence; they should link
here for progress rather than maintain another backlog. Provider execution belongs
to the [meta-harness map](meta-harness-map.md); remote channels belong to the
[remote-control map](remote-control-map.md).

## Current state and release boundary

| Area | What is established | What is not established |
| --- | --- | --- |
| Shared agent API | Bound handles, explicit reads, strict scoped targeting, lossless values, deliberate images and structured action outcomes; old public API replaced. In source (September 30): each result prints in its own compact form, observations as a reading outline, one-line failures. | Installed acceptance of the September 30 forms, all error paths, broad fresh-agent usability and matched comparative task performance. |
| Browser capture | Installed ordinary Aside preview/recording reaches 56.84/57.73 distinct fps at 1920×1080 with two viewers, exact inputs and unchanged screenshot pixels. Corrected loaded input-to-visible p95 is 121/73/82 ms for click/type/scroll through a production offscreen viewer. | Earlier installed loaded recordings and the combined-build 120-second isolated-host run interrupt at the two-second backlog guard; the uninstalled timestamped source completes them. A matched A/B shows preview rate follows machine load (47.97–58.25 fps), not encoding method; the 55-fps preview gate under contention stays open. Sustained efficiency, physical-screen latency, remote delivery and broader native rates remain open. Focus-off hidden tabs may produce no frames. |
| Native capture/input | Mac +mako.24 selected for new launches (September 26): a daemon killed or stopped mid-key no longer leaves the key held, and typing text already in a field is no longer falsely confirmed; running daemons keep +23 until their host starts a new one. Connected implicit-session idle lifetime and right/double-click cursor acceptance pass; fresh isolated right/double-click recording passes; the current default-host daemon loads +23 and installed right-click timeline propagation passes; tested exact AppKit file selection/cancellation; exact-value routes, bounded settling, recording and scoped gestures. A 60-second 1080p trial reached 57.35 distinct fps with unchanged foreground samples. English keyboard trial retained exact text during eight background saves with no observed focus interruption; human attestation is pending. Focus recovery remains reactive (23–99 ms in deliberate activation tests). | General proactive prevention, physical IME, universal gestures and exact 60 fps remain unproven. Sandboxed AppKit Open/Save semantic workflows pass with the separate panel service confirmed. Incomplete panel trees, raw cross-process input and broader dialog families remain gaps. Linux accepts 60 fps requests (+19, repeated on +24), but its native CLI clip is under a second; GNOME capture polls at ~5 fps. |
| Standalone Linux | +mako.24 with the current engine (September 26) passes ARM64 X11 jobs/recording, three Sway scale/rotation configurations, labwc/Weston/KWin, GNOME 46, both CLI workflows and eleven lifecycle cases. Native AMD x64 (EC2, AMD EPYC 9R14) passes the five acceptance suites, both CLI workflows and eleven lifecycle cases on +mako.24 (September 26). Acceptance containers now run as any calling UID. [+24 evidence](audits/2026-09-26/linux24/README.md). September 28: the same native x64 suites pass again with the current engine (A23 CLI, R23 and encoder fixes), byte-identical to candidate `13a82042e7e655bd` ([evidence](audits/2026-09-28/linux24/x64-native-ec2/README.md)). | Public distribution, remaining compositor versions, real GPU/display coverage or sustained capture-rate parity. |
| Installed components | **September 28:** installed and running is `869dadbcbbd1a69d` (built 06:05 UTC Sep 28 by Mako's in-app updater from this checkout). It contains the fixture desk (A09), the native session expiry retry (A22), the window-state error text and the meter stall fix; its installed fixture desk and idle `get_window_state` checks pass ([delivery order](#delivery-order)). Queued September 29: a candidate from `dac8a05` (`release/rollout-20260929`). Two earlier jobs withdrew because the development app reopened Mako mid-install (ledger R24, fixed in `dac8a05`). It adds host-sized preview frames and the viewer report, the A23 CLI changes, the R23 screenshot fix and the encoder fast failure. The record below is from September 26: installed and running was `3ba69b6e251ab7e7` (built 10:23 UTC Sep 26 by the other contributor's `release/rollout-20260926c` job, installed 10:27 UTC; default host PID 12099). Its Local Control source is identical to this workstream's `26b4f06bc693a102` (installed 09:32 UTC, replaced an hour later); the 18 non-document files that differ are Cursor compaction, transcript UI and Linux runner scripts. Installed driver death, ordinary preview and fresh-agent LC-22 pass on it; the loaded preview's freeze gate fails; see [delivery order](#delivery-order). Local fixes made after it (not installed): the fixture desk (A09), named native sessions that ended after five idle minutes, window-state errors that hid the driver's message, and a preview meter that counted a viewer stall as an idle source. Previous: `6ac3f4fbd690b74d` (built 01:15:34 UTC Sep 26), installed 01:25 UTC, startup verified, Settings receipt `ok:true`. Installed recording, MCP, native cursor-idle and both two-minute preview/recording jobs pass. It replaced `c291bf2845c02eec` (built 22:21:43 UTC, installed outside this workstream), which is retained as the backup. Earlier combined build `1fb3bfb7b3d14e96` (21:51:28 UTC) passed fresh default-host browser/native recovery. Sustained recording still interrupts. Previous builds `3c865f5347d339c7` and `48bf10dc948aa13c` are historical. Earlier build `9b696b0d9525e7e9` passed installed signature/host/module identity with recipe-4 media. [Installed media acceptance](local-control-installed-media.md) exposes loaded-recording and native cursor failures. Earlier build `3c1d563e25a9bd78` established the following agent-integration checks; +mako.24 is now selected for new Mac driver launches (September 26); the current installed daemon still runs +mako.23 until its host starts a new one. Installed package/host identity, SDK/CLI/MCP state, Aside exact-save/dialog/images, native exact values, reset/worker-fault recovery and MCP/browser reconnect checks pass. Default-host Codex compaction and task interruption/resume pass with 1,006 foreground samples without fixture activation. ASAR metadata cache failure is fixed in deployment tooling. [Installed evidence](local-control-agent-repl.md#september-24-installed-acceptance-and-recovery); [receipt](local-control-mcp-deployment.json). | Model compaction/interruption acceptance is scoped to Codex/macOS. Other providers, Linux and broader whole-job/streaming acceptance remain separate. Browser reconnect may remove temporary tabs; no automatic replacement or replay. |
| Packaging | Retired npm Cua SDK and regular-profile debugging scans removed; target-specific builds, media recipes, licenses, ignores and archive checks exist. | Complete installed-size/performance budgets for every supported release target and a proven smaller native build profile. |

Evidence: [capture and final cloud packages](audits/2026-09-23/local-control-capture21/README.md),
[native Intel jobs](audits/2026-09-23/local-control-native-x64-cloud19/README.md),
[current AMD and physical typing validation](local-control-native-validation.md),
[Mac focus and Sway timing](audits/2026-09-23/local-control-focus15/README.md),
[earlier installed Aside](audits/2026-09-22/local-control-packaging/README.md).
Audit media and machine-local artifacts may be ignored or absent in a fresh clone;
retain reproducible scripts and package provenance. A missing artifact is not a pass.

## Decisions to preserve

- One provider-neutral TypeScript engine behind MCP, SDK and CLI; composability is required.
  Preserve task ownership across separate shell invocations. Local Mac, remote
  browsers and future Linux cloud jobs use that engine with verified backend
  capabilities. Live streaming is an engine output, not a third automation system.
- MCP is the primary Mako agent integration: persistent JavaScript calls the typed
  session directly. The optional CLI borrows that engine independently of MCP.
  Never create a second task owner, target cache or input/recording implementation
  per interface. The old status/help/exec tools stay retired; other Mako MCP
  integrations and the native driver's private protocol remain separate.
- Live preview/recording performance target: 1920×1080 at 60 distinct fps.
  1440p/4K is optional, not a release gate. Preserve full-detail explicit screenshots
  and exact coordinate geometry. Do not resize user pages to satisfy a video target.
- Accuracy comes before throughput. Dispatch and UI quiet are not task success;
  verify exact target state. Never replay an action with an uncertain outcome.
- Observation and images are explicit. Scoped reads must preserve completeness,
  exact values and ref/lineage validity; text reads must not capture screenshots.
- Regular Chromium profiles use the extension and the user's saved browser choice.
  Prefer the OS-default supported Chromium browser where no choice exists; do not
  silently substitute Chrome, another profile, or direct debugging after failure.
  Keep explicit CDP routes for desk/Electron and owned cloud/test browsers.
- Preserve popup/opener/named-window semantics. An isolated cloud desktop contains
  focus effects; a regular desktop cannot claim universal background popup behavior.
- Retain the patched Cua native executable. Browser control is Mako-owned. Remove
  proven unused dependencies, not verified native functionality or license files.
- A live Mako desk is a real app client. Looking at the interface without
  changing anything uses the fixture desk (`npm run desk:fixture`), whose host
  refuses every call outside `electron/contracts/fixture-desk-policy.ts`. Add a
  channel to that allowlist only after reading its handler; a renderer stub or
  label is not a boundary.

## Delivery order

**October 2: candidate work from Cua, beyond the driver ([review](audits/2026-10-02/cua-borrowing/README.md)).**
Nothing is adopted yet. Mako's driver fork pins upstream 0.28.2, ten releases
behind 0.32.0, so it lacks capture-bound coordinate actions and visual
perception for surfaces with no accessibility tree. Ranked candidates:
1. capture-bound clicks, plus a fallback for surfaces with no tree;
2. a repeatable browser agent benchmark with reference and do-nothing checks;
3. disposable Lume macOS VMs for installed acceptance;
4. Linux worker readiness, accessibility and streaming rules;
5. machine-readable MCP results;
6. an approval broker so agents never hold secrets;
7. presence cursors and an input lease.

Cua Spaces, `cua-spacesd`, Keyvault and Teleport are FSL-1.1-MIT, so take
their ideas, not their code.

**September 30: the usage-audit fixes ([U01–U11](local-control-agent-issues.md#september-30-usage-audit)) are in source, not installed.**
They come from reading every SDK call agents made through Mako. The changes:
- page verbs, so pages need no raw CDP: `waitFor`, `evaluate`, `inspect`, `hover`, `drag` (including HTML5 drag and drop) and `scrollIntoView`;
- name patterns;
- REPL cells that can redeclare bindings and `return`;
- refs that survive a page screenshot;
- documentation printed once, as plain text;
- smaller `apps()` and `tabs()` output.

`scripts/test-control-page-verbs.ts` checks them against a real Chromium it launches itself. Two fresh agents finished a seven-step page task with at most one help lookup, no raw CDP and no sleeps. The next installed candidate must include them; then repeat that fresh-agent task on it.

**September 30, second pass ([U13–U24](local-control-agent-issues.md#september-30-usage-audit)): what agents read. Installed October 1 in build `e5b103991ebe70ef`.**
Every result now prints in a form made for what it is, and keeps its full value
for code. The changes:
- page observations print as a reading outline, with prose as `text:` lines and
  inline links `[name](e12)`, each fact once;
- page refs are `e<n>` and last across reads until the tab's next action;
- `observe({offset})` pages through long pages;
- receipts, discovery, screenshots and waits each have their own line format;
- failures take one line, plus what the cell had already done;
- Playwright-name misses say what to call instead;
- a late callback error no longer resets the REPL;
- `tab.expect` takes page conditions;
- native refs are `n<k>`.

Measured with the o200k tokenizer, the Hacker News and BBC News front pages,
read whole, print in 3,322 and 3,173 tokens instead of 10,932 and 9,088. The
first read of GitHub, MDN and Wikipedia pages takes 49–58% fewer tokens. All
`packages/control` tests and the browser, REPL, CLI, page-verb, computer-tool,
owner, modal, input-error and package suites pass. `test-control-api-e2e` was
not rerun: it drives the stale `dist-electron`, and rebuilding it would compile
other agents' uncommitted work.

Two fresh agents then did the seven-step task, plus a table-reading step, with
no help lookups. They read the outline without explanation. The first took 9
calls with 3 errors, and the fixes for its reports followed (U23). Those fixes
were:
- unnamed `within` scopes;
- a stale-ref error that names the call that changed the tab;
- receipts named by SDK call;
- a printed form for `inspect`;
- documentation of which calls expire refs.

The second agent took 7 calls with 1 error. Its main complaint was the
documentation's dense paragraphs. The once-per-session documentation now opens
with an example task cell, followed by short sections with one fact per line:
1,602 o200k tokens, against 1,335 at the previous commit.

Running that example cell on real Chromium found four more problems (U24), now
fixed:
- A form printed each label twice. Label text is now left out when it names a
  control that already holds it.
- A ref no read had printed was reported as expired.
- Page waits in hidden task tabs were about 1,000 ms late. They now poll from
  the session every 50 ms, and measured lag is 17–53 ms.
- An invalid wait selector failed as a schema dump.

A third fresh agent (run 5) then did the task on the restructured documentation
in 6 calls, with no errors and no help lookups. Following its reports:
- the first cell's result now follows a `This cell's output:` line;
- the docs say how `within`, `absent` and `hidden` behave in `expect`.

**October 1: installed check of the second pass ([U25–U27](local-control-agent-issues.md#september-30-usage-audit)).**
- The packaged CLI and recording tests passed on build `e5b103991ebe70ef`.
- The end-to-end API test then found U25: installed control workers run in
  Electron's Node mode, and the commands they ran inherited it. So
  `launch_app` with `page_route:true` started every Electron app as plain Node.
  Development workers run under Node, which is why only an installed build
  shows it.
- Reading the installed MCP tool from Cursor found U26: text blocks run
  together in clients that join them with nothing between them.
- A connected Brave profile listed as "Chrome · Kashyab" (U27). Brave copies
  Chrome's user agent and launched Chrome's native-host helper. Listing now
  names a browser from the application that launched its host.
- All three are fixed in source, not installed. With the fixed runtime, the
  end-to-end test passed against the installed `dist-electron`.
- The packaged MCP test now uses any Chromium profile with the extension
  connected, or `MAKO_ACCEPTANCE_BROWSER`. It passed on Brave.

To run a repo test against installed code without rebuilding `dist-electron`:
1. Copy the test and `scripts/lib` into a scratch folder under `scripts/`.
2. Point its `../dist-electron/` and `packages/control-runtime/dist` imports
   into `/Applications/Mako.app/Contents/Resources/app.asar`.
3. Run it with `ELECTRON_RUN_AS_NODE=1 /Applications/Mako.app/Contents/MacOS/Mako`.
4. Delete the scratch folder.

Next: install U25–U27, then rerun `test-control-api-e2e` on the installed
runtime.

**Next (September 29): candidate from `dac8a05` installs when the default host is idle (`release/rollout-20260929`).**
Both earlier jobs stopped the same way. The host quit for the install, Mako was
reopened within seconds, and the job refused to continue: "The shared host
changed while waiting. Nothing was installed." (04:23 and 05:04 UTC September 29,
for `13a82042e7e655bd` and `973fabfc73ce3aa3`). The second time, the reopened
host (PID 21508) was a child of the development app (PID 66712), which reopens the
default host when it resolves a shared conversation. That wake is supposed to
refuse a host being replaced, but the reservation marker sat inside the host's
runtime directory, and a quitting host deletes that whole directory. So the
reservation disappeared at the exact moment it mattered. `dac8a05` moves the
marker beside the directory (`mako-host-<id>.replacing`); readers accept either
location. Its regression test in `test:shared-conversations` deletes the host
directory after reserving, and it fails without the fix. The development app still
runs the old reader, so this job also restores the old marker within 10 ms of
the quit until the new app is installed, and relaunches with `open -g`. This
Mako task counts as active work, so the install happens only after it ends and
every Mako agent is idle. The watcher `dev.mako.rollout-20260929.after` then runs
the installed fixture desk test and writes `release/rollout-20260929/after-install.json`.
The fresh-agent prompt is saved beside it; the one change from September 26 is
that the agent uses the preferred browser.

Before the install (September 28): R23 reproduces on `869dadbc` in the preferred
Chrome on a 1512-CSS-px viewport (528×37 at 0.974), so the check below needs no
wide page. The capture source recovered by 22:00 local. Source-mode host-sized
preview reached 58.40 fps, and with four load workers 57.03 and 57.68 fps (longest
gaps 88 and 216 ms). Full frames at that load passed too, so the installed audits
can now judge both gates.
[A/B](audits/2026-09-28/preview-sizing/README.md).

Read `release/rollout-20260929/install-state.json`. After it installs, in order:

1. `node scripts/test-fixture-desk.mjs --app=/Applications/Mako.app` (the watcher
   runs it; read its receipt), and native
   `get_window_state` on the AppKit fixture before and after more than five idle
   minutes.
2. Installed ordinary and loaded preview audits (`--installed-session`,
   `--conversation`, `--extension`, `--two-viewers --recording`, as on September 26). The
   restoration check now reads the host's viewer report, so a failure names who
   holds the capture. Judge the 55-fps gate only when the source rate is near
   60 fps; it was 10–32 fps most of September 28 and about 58 by 22:00 local.
3. The same Shipping Save element screenshot on the installed candidate reports 542×38 at scale 1 (R23).
4. A fresh agent repeats the LC-22 task on the installed CLI (A23). Target: fewer
   than 12 help lookups and no program for work the CLI now does.

**Done September 28:**

- **First candidate `13a82042e7e655bd` (not installed; see above).** Built from a
  clean clone of `6cf09aa` with typecheck, packaging, packaged startup checks and
  eleven ASAR content assertions (host-sized preview frames, the viewer report,
  the A23 CLI receipt, scoped `act`, `expect` and the selector refusal, the R23
  screenshot fix and the encoder fast failure). Its job
  (`release/rollout-20260928`) waited without force-stopping anything and withdrew
  cleanly when the host changed.
- **Installed checks on `869dadbcbbd1a69d`, passed.** The fixture desk test
  gained `--app=<Mako.app>`, which runs its socket and page-proxy checks against a
  packaged bundle's own main process. On the installed app, every write,
  provider, git, process and unknown call was refused before its handler, reads
  and boot worked, and the host quit through its lifecycle. Packaged hosts serve
  no dev desk windows, so those checks stay source-only. Native `get_window_state`
  on the repo's AppKit fixture succeeded 397 s after the previous read; the
  driver's session TTL is 300 s, so the retry under a new session name ran (A22).
- **Viewer freeze under load: diagnosed and fixed locally** (item 2, ledger R22).
  Viewers were sent full 1920×1080 frames to paint 288×162. The host now scales
  frames to the largest displayed viewer: 73–87% of source frames composited
  against 27–31%, and 220 against 100 frames painted under four load workers.
  [Write-up](local-control-media-fixes.md#host-sized-preview-frames-local-september-28).
- **Page left visible after the last viewer closed: instrumented, and passing
  from source.** The host now reports who holds a task's capture
  (`mako:control-preview-viewers`). A real Chrome profile through the extension
  restored the tab to hidden with no viewers and no capture. The installed hold is
  not yet explained; step 2 above names it.
- **A23 fresh-agent friction and R23 scaling: fixed locally** (ledger rows).
- **Linux:** the contributor's x64 workflow is still unpublished; native x64 on
  EC2 passes again with this engine ([LC-25](#lc-25--linux-backend-and-cloud-coverage)).

**Earlier queue record (September 26, local, not installed):** build and queue one candidate with
the fixture desk (A09, [LC-23](#lc-23--preview-isolation-and-installed-browser-rollout)),
the native session expiry fix, the window-state error fix and the preview meter
stall fix, using the install job's own lifecycle and cancel path once the default
host is idle. Not queued yet: the installed app is the other contributor's
`3ba69b6e251ab7e7`, whose receipt still lists their installed checks as remaining
(`release/rollout-20260926c/install-state.json`); replacing it first would cut
those short. Then run the installed fixture desk test and native `get_window_state`
after more than five idle minutes. Open after that: the loaded preview freeze
(item 2), the restoration visibility failure (item 2), and the LC-22 usability
findings.

**Milestone (September 26): this workstream's Local Control changes are installed and pass installed checks.**
`26b4f06bc693a102` installed at 09:32 UTC (startup verified). At 10:27 UTC the
other contributor's job installed `3ba69b6e251ab7e7`, built later from the same
working tree: identical Local Control source plus their Cursor compaction,
transcript and Linux runner changes (`release/rollout-20260926{b,c}/source-*.json`).
The checks below ran on `3ba69b6e251ab7e7`, from a Mako task against the default
host (PID 12099):

- **Driver death (LC-08), passed.** Through the default host's task session and
  its embedded daemon: killing the stdio driver mid-typing reports `driver-exited` /
  `unknown`, blocks the target until it is observed again, and replays nothing; a
  daemon killed with SIGKILL mid-key has its key released by the replacement
  daemon; one stopped with SIGTERM releases its own key. Typing "y" into "zzyy"
  gives "zzyyy". Neither fixture was ever activated. Script:
  [installed-driver-death.mjs](audits/2026-09-26/installed-3ba69b6e251ab7e7/installed-driver-death.mjs).
- **Preview, ordinary load: passed; heavy load: labelled, but the freeze gate
  fails.** Numbers are in item 2.
- **Fresh-agent LC-22, passed (browser).** The fixture's own record shows the
  intended Shipping and Billing values and exactly one generate; the agent needed
  12 help lookups. Usability findings are in [LC-22](#lc-22--agent-facing-contract-and-discovery).
- **Found while checking:** native `get_window_state` failed with a bare error.
  The driver ends a named session after five idle minutes and then refuses calls
  that name it, and Mako's window-state compaction discarded the driver's
  message. Fixed locally (`control-session.ts`: one retry under a new session
  name, which is safe because the driver refuses before running the tool; errors
  keep the driver's text). `test-native-session-expiry.ts` fails without the fix.

**Previous queue record (September 26, 09:18 UTC): candidate `26b4f06bc693a102` installs when the default host is idle.**
It contains native driver-death handling (LC-08), program syntax errors as
`not-dispatched` (ledger A21), the preview shown rate (item 2 below), LC-22
discovery guidance and visible text, and viewer displayed-size decoding (item 6).
Typecheck, packaging, both packaged startup routes and ten direct ASAR file checks
passed; all 1,922 source hashes matched before and after the build
(`release/rollout-20260926b/build.json`). The earlier candidate
`5dae8d5ec1dd45ba` (driver death only) was withdrawn through its cancel path: the
pending quit was cancelled in the host, and its job recorded `not-installed` and
released its reservation. The new one-shot job (`dev.mako.rollout-20260926b`)
reserved the host and asked it to quit after work; the only running work was the
Mako task that queued it, so installation happens when that task ends. Read
`release/rollout-20260926b/install-state.json`; it ends at
`installed-startup-verified` or says why not. Then run the installed LC-08
driver-death acceptance through the default host.

**Previous milestone (September 26, 01:25 UTC): build `6ac3f4fbd690b74d` is installed and passes installed acceptance.**

Installed jobs from a Mako task on the new default host: packaged browser/native
recording, MCP (reports the installed build), native cursor idle check, and both
two-minute preview/recording jobs. Ordinary: 59.54 preview / 58.17 recorded fps,
83 ms longest hold, click/type p95 96/72 ms. Two load workers: 59.72 / 58.70 fps,
133 ms hold, click/type p95 82/76 ms. Both complete 121.5-second recordings with
exact inputs, zero pixel differences and unchanged foreground (662/652 samples).
Machine load averaged ~11 in both, so this does not re-test the heavier contention
under which the candidate's loaded preview reached 53.38 fps; item 2 below stays open.
Evidence: `release/rollout-20260925b/installed-*.log`.

Pre-install candidate record follows.

The candidate contains the recorder-freeze, fixture, receipt and wake fixes and the
landed OpenCode work. Typecheck passed and all 1,923 source hashes matched before
and after packaging. Direct ASAR checks confirm the shared-conversation, installer,
update, OpenCode and recorder modules. Both packaged startup routes pass (1,120
files, 745 imports). Using its own signed modules in isolated hosts, packaged
browser/native recording and MCP checks pass. Its two-minute ordinary preview job
passes: 58.05 preview / 57.20 recorded fps, 250 ms longest hold, all inputs and
pixels exact. The added-load job completes its full 121.6-second recording at
51.12 fps with a 217 ms longest hold (no freeze), but preview reaches 53.38 fps
and fails the 55-fps gate.

The only active host work was this Mako-hosted task, so installation cannot happen
inside it. A one-shot launchd job (`release/rollout-20260925b/install-after-idle.mjs`)
reserved the host, requested quit-after-work, and waits without force-stopping.
It then installs, reopens and verifies the new host's build. `mako-dev` (idle, older code
without the reservation check) was still running; if it reopens the old app, the
installer aborts without replacing anything. Read `install-state.json` for the outcome.

Earlier combined build (history): `/Applications/Mako.app` and the default host PID
20718 both reported build `1fb3bfb7b3d14e96`, built at 21:51:28 UTC. The full-workspace build includes the
other contributor's local changes: all 1,907 source hashes matched before/after
packaging, with direct ASAR checks of Codex/Claude drivers and permission modules.
The connected default-host daemon PID 25450 loads `+mako.23`.
[Combined build](../release/combined-local-20260925/combined-build.json) and
[installer result](../release/combined-local-20260925/install-state.json) retain
provenance and the automatic acceptance failures.

Automatic bundled recording, MCP/browser/native recovery and private native
idle/cursor checks pass. The fresh task then passed regular-profile Aside
interruption/reclaim and native exact saves, screenshot and recording through the
actual installed default host. Native right-click recording now contains its three
pointer samples. No second task session or unknown-action replay was used.
[Current installed evidence](local-control-installed-media.md#combined-build-installed-follow-up).

The 120-second isolated installed-module preview test reached 56.12 distinct fps,
with all 36 exact input checks and screenshot pixels correct. Recording interrupted
after 50.10 seconds at the unchanged two-second backlog guard; its playable prefix
is 47 seconds / 53.06 distinct fps. This remains a failed complete-recording job.
The first 44.79 seconds cost 1.25 host-plus-encoder CPU cores and 432 MB peak summed
RSS, excluding browser/viewers and GPU/media-engine power. Earlier two-minute
source-host passes and shorter candidate passes remain valid only for their scopes.

Next:

1. Finish recording behavior under contention, then validate the installed build.
   The local worker now explicitly releases consumed RGB buffers after pipe
   completion. A repeatable render probe uses 44% less CPU with unchanged pixels;
   the two-minute ordinary source-host job passes at 56.97 preview / 55.52 recorded
   fps (1.12 host-plus-encoder cores, 476 MB peak summed RSS). The added-load job
   still interrupts at 33.95 seconds and preview falls to 51.28 fps. The user chose
   to continue recording at an explicitly reported lower fresh-frame rate under
   contention. Timestamped variable-rate encoding now does so locally: the loaded
   job finishes at 121.68 of 121.68 seconds with 54.40 recorded fps and 204
   reported skipped slots. Ordinary recording passes at 55.22 fps, but preview
   misses the unchanged 55-fps gate (54.40 ordinary, 52.61 loaded). Linux FFmpeg
   5.1 compatibility and libx264 timing were corrected after review; only the
   synthetic Linux worker probe covers them.
   [Timestamped recording evidence](local-control-media-fixes.md#timestamped-recording-under-contention-local-follow-up).
   A matched four-run A/B (constant-rate vs timestamped, interleaved) found no
   encoding regression: preview tracked machine load in both arms (A 51.30/58.25,
   B 55.36/47.97 fps). It exposed a recorder freeze instead: when encoder lag
   passed two seconds, the scheduler discarded its backlog and held one image for
   2.03 s. The scheduler now trails by at most two seconds and skips evenly; a new
   throttled-encoder test fails the old logic and passes the fix.
   [A/B and freeze evidence](local-control-media-fixes.md#matched-encoding-ab-and-the-two-second-recorder-freeze-local-follow-up).
   Installed acceptance for this item passed on `6ac3f4fbd690b74d` (see milestone).
2. Preview under contention: frames are lost inside Mako, not in Chromium. Across
   the A/B and candidate runs Chromium announces 58–60 frames/s at every load;
   viewer reads fall to 51–56/s under load. The production viewer pulls frames
   (notification, then a renderer → main → host read, one in flight, extra
   notifications coalesced), so any hop slowed by CPU contention costs frames.
   A parked next-frame read (host holds the read until the next frame) was built,
   measured and reverted. At load 8–14.5 both arms held 58.3–59.7 fps. Under four
   load workers (load 16.5–24) fps followed load in both (original 47.97/26.68,
   parked 49.03/34.71), and parked reads still fell to 0.63 per frame. The loss is
   CPU-starved per-frame work, not the notification hop. The user chose to cut
   per-frame viewer work first; that is done (item 6) and lowers viewer CPU per
   frame by about 8% without changing ordinary fps. The 55-fps gate under heavy
   contention stays open. **Decision (user, September 26): under heavy load, accept
   a lower preview rate and show it,** the way recording already reports skipped
   frame slots. **Done locally, in the queued candidate:** the host counts
   source-clock 60 fps slots that held a frame; each viewer compares its painted
   frames and shows "N of M fps" below 90% of full rate (cleared at 95%, or a
   second after the last paint). Ordinary audit 59.41 fps, never labelled; load
   ~41 gives 40.87 fps, labelled in 4 of 27 samples, because Chromium itself fell
   to 41–51 fps there, which the viewer cannot count. The 55-fps gate now applies
   to ordinary load only. **Installed (build `3ba69b6e251ab7e7`, same Local Control source as `26b4f06bc693a102`, September 26):**
   ordinary 60 s passes at 58.28 fps, never labelled, 176 ms longest gap; a 30 s
   recheck gives 59.54 fps, 67 ms. Loaded runs label the loss (two workers, load
   11.7–20.2: 50.94 fps, 50 of 107 samples labelled "47–55 of 57–60 fps"; four
   workers, load 6.6–25.9: 35.81 fps, 21 of 111 labelled) but fail the freeze gate
   (521 ms and 1,349 ms longest gaps). Recording from the same stream never held
   longer than 267 ms, so the freeze is on the viewer path. It is the only
   installed gate that fails under load; no stage timing isolates it yet. The
   1,349 ms freeze exposed a meter bug: a gap over a second reset the window as if
   the source were idle, hiding exactly that stall. Fixed locally: a long gap
   during which the source kept producing now counts
   (`test-control-preview-painter.ts`); not installed. Both foreground changes
   during these audits were physical clicks into Aside (WindowServer button events
   11 ms before activation), not the audit. Separately, the two-worker run and the
   30 s ordinary recheck failed the restoration check: after the last viewer
   closed, the page stayed visible and focused instead of returning to hidden.
   Not diagnosed yet; Mako's own preview consumer is one suspect. Logs:
   [installed audits](audits/2026-09-26/installed-3ba69b6e251ab7e7/).
   [Shown-rate evidence](local-control-media-fixes.md#preview-shown-rate-under-load-local-september-26).
   Process priority is weaker on macOS: without root Mako can
   only lower other work (for example agent subprocesses), not raise itself.
   [Stage breakdown](local-control-media-fixes.md#candidate-6ac3f4fbd690b74d-and-preview-stage-breakdown),
   [parked-read A/B](local-control-media-fixes.md#parked-next-frame-preview-read-measured-reverted).
3. Native fixture startup is fixed. The private-driver right/double-click
   recording passes with Aside frontmost (65/65 foreground samples) and with Mako
   frontmost (72/72 samples plus every call; fixture never foreground). One of six
   Mako-focused mouse-downs reports the fixture's own PID as event source; cursor
   and recording checks still pass.
4. Install receipt and host wake are fixed and included in the queued candidate.
   [Fixture, receipt and wake evidence](local-control-media-fixes.md#fixture-startup-install-receipt-and-host-wake-local-follow-up).
5. Restarting from a web client no longer opens a stray "Quit Mako?" dialog or
   asks the host to hide its desktop windows (local, verified in `npm run web`).
6. **Resolved (local): viewers decode and paint at their displayed size.** Each
   viewer holds exactly its device pixels (288×162 for the audit overlay instead
   of 1920×1080), decoded at the smallest covering JPEG eighth and shared between
   viewers. Checked in real Chromium at DPR 1 and 2 through `npm run web`, with
   resize repaint and a pixel oracle (38.2 dB against a high-quality downscale).
   A balanced six-run A/B: viewer renderer CPU per frame −22%, whole viewer −8%,
   22 MB less working set, fps unchanged; every displayed-size run passes the
   audit. Larger views get more pixels: a resize or pinch zoom re-decodes the held
   frame up to the full captured frame without another read (pinch checked in
   Chromium: 144×81 → 288×162 at 2×), so a future expanded view needs no viewer
   change. Browser screencasts stay capped at 1920×1080 (`browser-capture.ts`);
   the user accepted that as enough detail (September 26).
   Installed (September 26, `3ba69b6e251ab7e7`).
   [Design, tests and A/B](local-control-media-fixes.md#displayed-size-viewer-decoding-local-september-26).

[Media fixes and previous attempts](local-control-media-fixes.md) retain the
source/candidate tests, failed installers and exact driver lifecycle evidence.

**Cloud ordering:** define the Linux cloud-agent environment first (display/compositor, CPU/GPU availability, isolation, network and lifecycle), then choose and validate its capture/encoding/transport backend. Preserve the current Linux implementation and prototype evidence; defer further cloud streaming implementation and Moonlight/Selkies adoption until that prerequisite. Mac and cloud retain the same typed session, ownership and recording API.

**Preserved integration decision (September 24): SDK + composable CLI + persistent JS MCP.**
After reviewing the current unified cua_repl evidence, the user explicitly replaced
the CLI-only Mako integration decision. Mako agents should discover browser and
computer use through one persistent JavaScript MCP adapter, calling the shared
SDK/session directly, never spawning CLI commands. The basic CLI remains available
for external users and file pipelines. Streaming work follows this integration’s scoped correctness, discovery, lifecycle
and packaging acceptance, now passed for installed Mac/Aside + Codex. Preserve the existing browser/native functionality, lossless values,
exact target checks, background policy and recording cleanup. Agent discovery, focused runtime documentation and minimal startup/context cost
are primary acceptance criteria. Keep the CLI’s existing file/stdin composition.


1. **Close correctness and misleading-result gaps** in LC-08 and LC-22, starting
   with raw-action uncertainty, capture geometry and precise recovery messages.
   Native driver death during input is done locally (September 26). Its two
   driver findings, the held key after daemon death and the false typing
   confirmation (ledger B05, B04), are fixed in driver +mako.24, which is
   installed for new driver launches. The host side is installed
   (`3ba69b6e251ab7e7`) and passed installed driver-death acceptance through the
   default host on September 26.
   Keep the full [agent issue ledger](local-control-agent-issues.md) accounted for.
2. **Finish LC-29 MCP discovery and LC-20 shared-engine release acceptance.**
   Run browser and native jobs through normal provider startup; preserve the basic
   CLI as a thin consumer of that same engine.
3. **Finish LC-21's interactive capture path and LC-24's native gaps.** Measure
   complete input → visible result and distinct source frames, then optimize.
   Native/transport investigation can proceed independently of the agent adapter.
4. **Complete LC-25/LC-26 target acceptance and packaging**, then LC-23's installed
   host/extension rollout. Run acceptance on the exact artifacts being deployed.
5. **Close LC-27 with repeated complete jobs through MCP and multiple
   harnesses.** Record the remaining unsupported cells explicitly.

The order is a working sequence, not a claim that every platform investigation
blocks every release. Each scoped release must state exactly which gates it closes.
Statuses below distinguish implementation from deployment and broader acceptance.

## LC-20 — Shared engine and composable CLI

**Status: revised signed candidate and fresh-agent jobs pass; idle deployment timed out without replacing the app.**
[Commands and lifecycle contract](local-control-cli.md),
[September 24 evidence](local-control-cli-evidence.md),
[fresh-agent CLI and reference review](local-control-cli-review.md),
[modal fix and packaged acceptance](local-control-cli-modal.md),
[live deployment receipt](local-control-cli-deployment.json).

`createControlSession` owns program state, native policy, target evidence,
recovery and recordings. Desktop task supervisors start one worker and supply an
exact CLI shim/session descriptor through every provider launch path. Browser
credentials stay in worker IPC. The old status/help/exec MCP adapter and launcher
were deleted. The September 24 revised decision adds a persistent-JS MCP adapter
that borrows this same engine; LC-29 owns its implementation and acceptance.
Private Cua protocol and unrelated MCPs remain.

CLI command/group help works offline, with signatures, outputs, examples and
structured `--json` help. `api` loads focused runtime reference. Separate CLI
processes share state through an owner-only Unix socket with exact session/code
identity. Text reads take no screenshots; media is written to files. No source,
continuation ticket or uncertain action is automatically replayed.

September 24 acceptance:

- Fresh Codex, Claude and Cursor browser jobs used the CLI, completed verified
  forms with trusted input, read screenshots and closed their task tabs. Codex
  also completed a native AppKit form. Cursor's earlier private-socket workaround
  is a rejected run; the repeat used a frozen runtime and passed through the CLI.
- A native Terminal CLI job independently verified its command output with 67
  unchanged foreground samples. This is separate from physical IME/human typing.
- Real Linux ARM64 Chromium and GTK CLI workflows passed exact values, scoped or
  resized captures, recording finalization and cleanup. All eleven isolated
  Linux lifecycle scenarios passed. The current CLI also passes native AMD x64
  browser/native jobs and all eleven lifecycle scenarios; see the native validation.
- Desktop tests cover explicit stop, worker/parent SIGKILL, private-file cleanup,
  lost-worker browser ownership cleanup and stripping inherited control secrets.
- Packed Node imports/types, relocation, code identity, worker/artifact lifecycle,
  package bounds and secret canaries passed for the CLI-only candidate. The new
  `/mcp` export now passes the revised package acceptance in LC-29.
- The final shell fixture took 3.50 s; command p50 was 100 ms and p90 114 ms
  including process startup. These are fixture timings, not real-page or viewer
  latency. Four concurrent programs also preserved shared state.

Help efficiency remains an LC-22 acceptance item: Cursor completed correctly but
made eight help calls. Preserve that evidence; do not call the learning overhead
solved solely because the task passed. Fresh ACP-provider workflows also remain
unmeasured; their launch paths share the CLI environment/instructions.

Signed candidate `15ebe10a1502342e` passed actual ASAR worker/CLI tests, both
packaged startup routes and 40 regular-profile Aside jobs. The run verified exact
values, duplicate Save refusal, dialog handling, recording, interrupted-video
retention, reconnect and stale-handle refusal; all 326 foreground samples stayed
on the initial app. This tests the candidate against the installed extension,
not the default installed shared host. The full app is 662,882,436 bytes.

The revised candidate `7b0a2c623f935da0` includes result-publication and startup
cancellation corrections, event-driven modal interruption, mouse/key cleanup and
focus restoration after dialogs. Two fresh agents passed against its immutable
ASAR, including media and browser close verification. Browser help needed two
calls; native needed three including a logging repeat. The older generated
candidate was removed after shutdown; its historical acceptance remains above.

Next: complete installation and installed acceptance after active work ends. The
September 24 idle wait expired after 30 minutes; nothing was replaced. Read the
[deployment receipt](local-control-cli-deployment.json) for actual state. The updater refuses host/build replacement and never force-stops
work. Native AMD CLI acceptance now passes; repeat remaining provider launch
paths. Streaming stays paused until the release gate closes. LC-22 also tracks
bounded partial output from failed exec programs.

September 24 source continuation: the shared runtime now allocates private Unix
endpoints by UTF-8 byte length, including long state/TMPDIR paths. Desktop/cloud
runtime roots preserve crash cleanup ownership. Startup failure, dead-owner
cleanup, active-session preservation and packed relocation pass; no dependency
was added. [Socket and native-read evidence](local-control-dialog-depth-evidence.md).
These source changes still require desktop rollout.

## LC-21 — Responsive capture, recordings and cursor

**Status: combined build `1fb3bfb7b3d14e96` and driver +mako.23 are installed. Fresh default-host browser/native recovery and right-click cursor propagation pass. Local render-allocation changes pass a two-minute ordinary source-host job at 56.97 preview / 55.52 recorded fps; added-load recording still interrupts. That fix is not installed. The user approved continued recording at a reported lower frame rate under contention. Local timestamped encoding now completes the added-load two-minute recording at its real duration (54.40 recorded fps, reported skips). A matched A/B attributes the preview misses to machine load, not encoding, and exposed a two-second recorder freeze under sustained pressure, now fixed locally. The native fixture no longer activates at startup, and right/double-click recording passes with Aside or Mako frontmost. Build `6ac3f4fbd690b74d` carries these fixes and is installed. Installed two-minute jobs pass, ordinary and with two load workers (59.54/58.17 and 59.72/58.70 fps at load ~11). Under heavier contention the viewer's pull loop still loses preview frames (candidate: 53.38 fps). The user accepts roughly 56 fps; 60 remains the target.**
[Streaming experiment and acceptance plan](local-control-streaming.md),
[Reported capture issues](local-control-agent-issues.md#capture-recording-and-preview).

The [current investigation](local-control-media-investigation.md) records the
implementation, failed experiments and acceptance gates. Continuous encoding
removes source-JPEG staging; clocks/cursor timing and native no-transform output
have focused tests. [Binary delivery and shared JPEG decoding](local-control-preview-binary.md) now keep preview pixels out of JSON. The final source runs complete with exact pixels; the revised recorder also finishes the covered two-minute loaded job. Linux component/viewer measurements are documented; native Sunshine/Moonlight is deferred. Installed media acceptance remains open on the two failures above. Packaged
FFmpeg's fragmented and hybrid modes retain 120 decoded frames after a synthetic
encoder kill, whereas `+faststart` output is unreadable; clean runs retain all
180. This is container evidence, not a new capture-rate result. Hybrid needs no
new encoder dependency. Upstream pixelflux's built-in recorder requires changes
for encoded loss, timing and resize; its socket tap is a different implementation.

The production image renderer repeatedly replaced an unfinished async decode.
The new pixel-reading audit reproduced only 10 readable frames in four seconds
despite 222 host updates. A bounded decoder now keeps the last complete image and
one newest waiting frame. Corrected runs reached ~59–60 composited frames/s;
two viewers plus recording passed 36 exact input/visible-marker checks, zero
decoded-pixel differences at 1920×1080, and independent viewer/recording cleanup.
[Reproduction, measurements and limits](local-control-preview-evidence.md).

A separate-host comparison reduced socket response bodies from 17.62 to 11.98 MB/s
with identical decoded pixels and ~59 distinct fps. A later CPU-instrumented pair
was slower (49.75 vs 56.35 fps); tail latency and total resource cost remain open.
That earlier implementation used negotiated Brotli compression and expanded preview JSON across Electron IPC. Binary preview delivery supersedes that media path. September 25's LC-26 cleanup also removes the unused ordinary-RPC Brotli decoder after checking both source and installed host producers; ordinary RPC uses bounded identity JSON. Default input and capture now share a per-tab emulation hold.
The first live consumer enables painting; the last disables emulation. Text reads
stay unchanged, and no tab/window activation is requested. Focus-off embedders keep
no-frame refusal. Unit checks cover overlapping consumers/actions, screenshot
pause, startup/reset failure and interrupted acquisition.

The installed Aside extension with the source host passed a 30-second two-viewer
run at **58.03 distinct fps**, with 36 exact input checks, unchanged 1920×1080 decoded
pixels, 288 unchanged foreground samples and a finalized 37.73-second recording.
Streaming rendering removed the reproduced 512 MiB PNG staging failure. The
rebuilt minimal encoder passed browser/native cursor tests and failure cleanup.
Viewing/screenshot/transport-loss tests restore page focus and hidden visibility;
a click can leave Chromium's `hasFocus()` true after detachment while the tab stays
hidden. This limitation is recorded, not replaced by forced blur or tab activation.
[Measurements and limits](local-control-preview-evidence.md#september-24-capture-ownership-and-long-recording).

The current signed build's runtime acceptance is complete; sustained media checks
remain separate. An earlier sustained 1080p run sent **11.87 MB/s** compressed /
**17.67 MB/s** expanded preview data.
Electron working set rose from 867 MB to 1.20 GB; Node RSS stayed around 214–221 MB.
Those include the offscreen fixture and exclude installed browser/encoder CPU.
The 60-second runs at mixed capture sizes were slower and remain in the evidence.
The pre-continuous-encoding 60-second run with the explicit 1920×1080 source budget reached
**52.02 distinct fps** and stopped recording after **41.33 seconds** when retained
source JPEGs reached 512 MiB. The earlier fix removed decoded-PNG staging during
finalization; it did not remove source-JPEG accumulation during capture.
[Failure and measurements](local-control-preview-evidence.md#september-24-sustained-1080p-failure).
Continuous encoding now removes that source accumulation without raising the cap.
A later worker-rendered two-viewer Aside run completed 68.57 seconds with
53.76 distinct viewer fps and unchanged foreground samples. Its decoded video
reached only 48.58 distinct fps; it does not close the smoothness gate. Startup
prewarming fixes the initial encoder freeze. A bounded timestamped source queue
now preserves intermediate states during encoder catch-up, verified by pausing
and resuming real FFmpeg; decoded-marker tests also cover screenshot interference.
The subsequent timestamped-queue run completed 67 seconds: preview 56.53 fps,
recorded motion 56.82 fps, longest recorded hold 116.7 ms, all 36 exact input
checks and both pixel comparisons passing with unchanged foreground samples.
That run missed the former 57 fps floor. The user subsequently accepted roughly 56 fps; this does not waive exact pixels, input correctness, bounded resources or freeze checks. Recorder-only stress (including a ten-minute
run), bounded-backlog and encoder/host-death tests are separate from viewer-rate
acceptance. [Current implementation and limits](local-control-media-investigation.md#implementation-and-acceptance--september-24).
Binary media delivery now preserves the exact encoded bytes outside preview JSON. JPEG ImageDecoder output matched the HTML image oracle in the covered fixtures; the two viewers share one decode. [Implementation and evidence](local-control-preview-binary.md) separate failed decoders, production checks and installed acceptance. Keep the 1080p budget and report actual pixels; do not degrade explicit screenshots or silently reduce the requested size.
Finish actual pixel/DPR policy, resize/no-frame reporting, cursor legibility and
all gesture routes. Requested fps is now threaded through native capabilities/capture
in the +19 candidate: Mac/X11 advertise 60 and GNOME advertises 5, with source-rate
acknowledgment and refusal before unsupported starts. Replace GNOME PNG
polling with a continuous PipeWire source; compare XComposite texture import and
ext-image-copy-capture/DMA-BUF for Linux. These are explicit LC-21 work items, not
optional polish. [Source-reviewed projects and implementation gates](local-control-capture-backends.md)
cover OBS, wl-screenrec, Selkies, Sunshine and rejected alternatives. A getUserMedia
constraint does not upgrade native recording.

The next isolated Linux streaming prototype is **Selkies/pixelflux**, comparing
WebRTC with binary WebSocket delivery; **Sunshine/Moonlight** supplies the native
viewer comparison. pixelflux's encoded socket tap is a reuse candidate, but its
built-in recorder continues after encoded queue loss, uses delivery timestamps
and starts a second X11 encode. Both require explicit readiness/recovery checks.
Its Python extension and monitor-scoped portal capture are not a drop-in Node
dependency or exact-window backend. KasmVNC is a second cloud
candidate, not standard VNC compatibility. Ordinary VNC would use a separate
adapter (for example TigerVNC/noVNC) to the same job desktop, with input ownership
enforced and no second automation API. The need for standard-client interoperability
awaits clarification; no VNC service is enabled by this plan.
[Source review, prototype selection and gates](local-control-streaming.md#september-24-selection-browser-streaming-moonlight-and-vnc).

The source-rate candidate also fixes first-operation Mac recording: a fresh
ScreenCaptureKit filter could abort until an earlier observation had initialized
CoreGraphics. Capture now establishes the display connection and checks geometry
itself. A 10-second first-operation run retained 577 distinct 1920×1080 frames
(57.53 fps) with unchanged foreground samples. Linux's 5 ms sleep on every full
encoder-pipe write limited the test to 13.94 source fps. Waiting for writability
raised the same covered-window workflow to 56.70 source fps, preserving exact
values, blue target pixels and playable interrupted video. These are preliminary
candidate results; the Linux fixture is 640×420, not sustained 1080p acceptance.
The longer Mac run retained 3,400 distinct frames over 60.05 seconds (**56.62 fps**),
below the 57 fps acceptance floor. Foreground samples changed from Aside to Mako;
the sampler cannot establish who caused that change. The run did not pass.
Subsequent +19 trials passed the existing 57 fps floor: **57.44** distinct fps
for 30 seconds and **57.35** for 60 seconds at 1920×1080, with all 331/613
foreground samples unchanged. The signed driver is now selected for new launches.
Existing daemons were left running. This does not establish exact 60 fps, real
human input or proactive focus prevention; the failed longer trial remains above.
[Candidate provenance, failures and reproduction](local-control-native-capture-evidence.md).

Done per backend when moving content supplies approximately 60 distinct source
frames/s at the declared size under the accepted workload, controls stay responsive,
clips cannot corrupt video, cursor coordinates match dispatched actions, and output
reports its real geometry/rate/interruption. Static screens need no invented frames.
Compare screenshot/text fidelity and resource cost before accepting an optimization.
Profile the decode/composition/pipe path before choosing a performance change and
compare matched runs interleaved under the same load; delivered native video frames
are not distinct motion, and small-window proof is not 1080p acceptance.
The September Replicas review adds viewer-side unique-frame and p95 frame-gap
checks, an instrumented input-to-visible loop, a WebRTC candidate, damage/idle-aware
capture, compatible shared encoding and component-specific recovery. Test one/two
viewers plus recording; idle or hidden content must not trigger false reconnects.
Do not select a language/codec from a product claim or compare host fps with viewer
fps. [Detailed criteria and source](local-control-streaming.md).
Audio streaming and recording are distinct open capabilities; neither implies
microphone capture. Full human takeover is deferred; it is not a dependency of low-latency agent use
or viewing. Mac work continues now; the September 25 decision defers cloud-specific
streaming implementation until its Linux environment is defined.

## LC-22 — Agent-facing contract and discovery

**Status: partial; each original complaint has its own ledger entry.**
[Discovery/API issues](local-control-agent-issues.md#discovery-targeting-and-api),
[September 30 usage audit](local-control-agent-issues.md#september-30-usage-audit),
[recorded request-shape failure](audits/2026-09-22/background-control-fixes/agent-request-shape.md).

The SDK changes from the September 30 usage audit are in source but not installed. The documentation lives in `control-agent-docs.ts` (the tool description and the once-per-session docs) and in `controlHelp` in `control-session.ts` (the topics). Page verbs are browser commands in `contracts/browser-control.ts` and `browser-service.ts`: `inspect` is read-only, while `drag` and `scrollIntoView` mutate. The client methods are in `packages/control/src/control/client.ts`. Name matching is `nameMatches` in `scope.ts`, shared by the client, the browser service and native scoping. REPL source changes are confined to `replSource` in `program/repl.ts`.

Where printing lives:
- **Values to text.** The `PRESENT` symbol in `packages/control/src/control/present.ts` carries each SDK result's printed form. The REPL's `showValue` (`program/repl.ts`) and the worker's `console.log` print it; other values print as JSON and strings print raw.
- **Discovery lines.** `control/discovery.ts`.
- **Receipts.** `operationLabel` in `control/contract.ts`.
- **The page outline** has two halves:
  - what a row is: `browserObservation` in `control-runtime/src/browser-observation.ts` handles pruning, names taken from contents, label text (`labellingNames`), single-row collapse and `depth`;
  - how rows print: `pageOutlineLines` in `packages/control/src/browser/observation.ts` handles `text:` lines, inline links and printed refs.
  - The two share `PAGE_GROUPING_ROLES`.
- **Stable `e<n>` refs.** `refIds` and `binding.refs` in `browser-service.ts`.
- **Native `n<k>` aliases.** `withNativeTokens` in `control-session.ts`, applied before `beginControlMutation`.
- **Failures.** `programErrorText` and the effect list in `program/runtime.ts`; the method hints in `program/hints.ts`; `lastControlChange` in `control-session.ts` names the call behind a stale page ref, and `issuedPageRefs` tells a stale ref from one never printed.
- **Page waits.** The `wait` command in `browser-service.ts` polls from the session (`WAIT_POLL_MS`), not with page timers, which Chrome slows to about once a second in hidden tabs.
- **Scopes.** `ControlScopeSchema`, `inScope` and `scopeLabel` in `scope.ts`; `browser-service.ts` sends unnamed scopes down the snapshot path, since `queryAXTree` needs a name.
- **Inspection.** `inspectionText` in `client.ts`.

Native screenshots now validate supported options, honor resizing/format requests
and retain exact returned-image coordinate mapping. Native recording capabilities
derive their source-rate ceiling from the driver (new Mac/X11 candidates allow
60; the GNOME PNG source declares 5; older drivers stay fixed at 30). Unsupported
rates refuse before starting capture. Known startup refusals are `not-dispatched`.
Stale image/reference CLI faults use the recovery exit code. These close scoped
contract bugs, not general discovery/usability acceptance.

Shared input boundaries now return bounded `invalid-request/not-dispatched` faults
for common target, selector, read, action, screenshot and recording mistakes.
Misspelled click options cannot fall through to a default left click. Ambiguous,
missing and incomplete locator results carry explicit pre-dispatch faults. CLI
recovery warns that earlier program steps may already have completed; response
validation after a write still preserves unknown outcomes and the recovery guard.
Public scoped-edit/screenshot help examples pass against duplicate controls in
real Linux Chromium. [Evidence](audits/2026-09-23/local-control-input-contract.md).
This is executable-help acceptance, not a fresh-agent usability pass.

The first blind review needed 18 browser help/API calls and 16 logged native
help/API calls plus initial help. Revised packaged trials used two browser help
calls and three native calls (two distinct views) while completing exact edits,
modal recovery and media. The five-second click delay and modal focus-reset
attachment loss are fixed and regression-tested. Six result-publication failure
cases and both Linux startup signals preserve post-dispatch uncertainty.
[Modal and learning-cost evidence](local-control-cli-modal.md).

September 26 (local): a later program failure no longer hides earlier output
(ledger A18). Every failed run, including timeout and cancellation, keeps the
blocks it had emitted. CLI `exec` prints them on stdout in the success shape,
images already saved to files, while the fault keeps stderr and the exit code.
The browser program server returns them before its fault. Refused calls inside a
browser program also kept `protocol-error`/`unknown` while saying nothing was
dispatched (A19); they now report their real fault. Outcome uncertainty and
no-replay behavior are unchanged. CLI, browser-tools, REPL, runtime, input-error,
computer-tools and `test:mcp` suites pass, and mutations of each new path fail them.

September 26 (local, in candidate `26b4f06bc693a102`), the remaining discovery items:

- **Next operation (A01).** Every `control.browsers()` row carries `next`: the
  exact call its connection state allows (connect, open, claim) or the user
  action it waits for (allow the prompt, add the extension), or why connecting
  refuses.
- **No native windows (A02).** An empty `control.windows(pid)` says the process
  owns no native windows, that this is not a permission refusal, and that web and
  headless hosts, including Mako's own `--web` desk, are reached through the desk
  entry in `control.browsers()`. A PID with no process says so.
- **Live desk (A09 wording).** The desk's discovery guidance says it is a live
  client of the real app, not a sandbox. A fixture desk now says it only reads
  (see [LC-23](#lc-23--preview-isolation-and-installed-browser-rollout); local).
- **Visible text vs accessible name (A07).** Page controls report
  `visibleText` when their name does not contain their shown label (September 30;
  before, whenever the two differed); `query`/`text` search it; exact matching is
  unchanged. A miss for a name that is only visible text, or only part of the
  name, names the control's real accessible name.
- **Validation and help (A06/A08).** Wrong query shapes say where text search
  lives and that CSS is unsupported; every public help example compiles and calls
  only defined SDK methods.
- **Syntax errors (A21).** A program that fails to compile reports
  `syntax-error` / `not-dispatched` with its line, not `unknown`.

`test-computer-tools`, `test-browser-service`, `test-browser-tools`,
`test-control-repl`, `test-control-input-errors`, `test-desk-browser`, typecheck
and lint pass; real Chrome confirms visible text on labelled buttons and links.

**Installed fresh-agent run (build `3ba69b6e251ab7e7`, same Local Control source as `26b4f06bc693a102`, September 26): passed.**
A fresh agent with only the public CLI and help edited a local fixture with two
identical forms, set Shipping to "Ada Lovelace" and Billing to "Grace Hopper",
pressed Generate once, took an element screenshot (528×37) and made a 24.28 s
H.264 recording. The fixture's own server record confirms both values and exactly
one generate. It needed 12 help lookups. What slowed it down:

- `open` returns no URL or title, so the agent could not confirm which page it had.
- CLI `act` has no scoped locator, expectation or close, which forced a program
  for work the CLI should do in one command.
- `api --topic` does not list its valid topics.
- CSS-selector refusals print generic placeholders rather than the offending
  selector.
- The element screenshot came back scaled by 0.974 without `--max-side` having
  been asked for.
- The recording directory holds both `timeline.json` and `timeline.jsonl`, and
  help does not say which to read.

September 28 (local, queued in `973fabfc73ce3aa3`): each of these is fixed with a
test; details in ledger A23 and R23. `open`/`claim` print `{target, url, title}`,
and that receipt works as a target file. `act` takes `--role`/`--name` or a
`selector` with `within`. `expect` and `close` exist. `api` lists its topics. A
CSS or text selector is refused with the quoted text and the observe call to
use instead. Element screenshots keep scale 1 when Chromium returns a short view.
Help says which timeline file to read.

Next: repeat with a new fresh agent on the installed candidate, with the same
task and a target of fewer than 12 lookups. Capability/result typing and
long-running start/resume/cancel without guessing a ticket shape remain.

Done when a fresh agent can discover/connect, scope duplicate controls, capture an
element, handle an invalid request and finish/recover a recording from public help,
without raw CDP workarounds, private settings calls or an operator explaining shapes.
Use the [ledger](local-control-agent-issues.md) for exact bug closure criteria.

## LC-08 / LC-14 — Uncertainty, ownership and independent targets

**Status: target recovery, cancellation and native driver death implemented and fault-tested; installed acceptance passed on build `3ba69b6e251ab7e7` (same Local Control source as `26b4f06bc693a102`, September 26) through the default host with driver +mako.24: stdio driver killed mid-typing, daemon killed and daemon stopped mid-key, no replay, no false confirmation, keys released ([delivery order](#delivery-order)).** Found during that run and fixed locally: named native sessions end after five idle minutes, and window-state calls then failed without the driver's message. Program syntax errors now report `syntax-error` / `not-dispatched` instead of `unknown` ([A21](local-control-agent-issues.md#discovery-targeting-and-api)).
The shared host and BrowserService now classify browser commands by effect.
Read-only helpers preserve refs; raw mutations retire only their target's refs.
Lost raw browser replies block that target until a successful observation/capture.
Native preflight failures remain `not-dispatched`; post-dispatch failures remain
unknown. A failed unscoped native action blocks even previously unseen windows:
observe an exact window and continue through its handle. Another unscoped input
cannot be authorized by that window's observation.

Native driver reconnect preserves unresolved outcomes and browser evidence.
Missing screenshot data does not clear uncertainty. Initial and later topology
monitoring failures report `guard-unavailable`; the successful action receipt is
retained and continuation requires fresh target evidence. A read overlapping a
concurrent browser mutation cannot clear uncertainty or return current refs.
Dialog replies and event reads can run while navigation waits; ordinary mutations
remain ordered. An explicit answer to an open dialog can unblock recovery without
automatically replaying the interrupted action.

Cancelling a program preserves unknown outcomes even if the backend later returns
success. Cancelling only a cell wait leaves its eventual result collectable and
continues to prohibit resubmitting source before collection. It does not trigger
the cloud supervisor's program-cancellation teardown hook.

Evidence and commands: [recovery audit](audits/2026-09-23/local-control-recovery.md).
The MCP/shared-host fixtures, real WebSocket protocol fixture, program-runtime
checks, control package tests, host/UI typechecks and full lint pass. These are
controlled failure tests, not installed Aside or physical-input acceptance.

Browser-wide ownership is now implemented and tested: profile cookie writes
refuse other task owners and pending target acquisition; an in-flight profile
write blocks browser work. Lost replies invalidate peer evidence and require
observation on existing and later claims. Raw browser/profile administration
cannot bypass managed operations. App attachments belong to one task, reject
endpoint aliases and are released at teardown. This is cooperative ownership,
not security isolation between websites sharing a regular profile.

**Native driver death during input (local, September 26).** Either native process
can die mid-action: the session's stdio driver or the embedded daemon that posts
the input. What happens now:

- The call reports `driver-exited`. An interrupted action is `unknown` ("may have
  partly happened … a key pressed without its release"); an interrupted read is
  `rejected`. The program keeps running: control programs no longer cancel on
  driver exit (driver-surface programs still do, since their tool list came
  from that driver).
- Refs from the dead driver are void the moment it exits, not on reconnect. The
  next call starts a new driver; a failed start is `driver-unavailable` /
  `not-dispatched`. Nothing is retried.
- The affected window (every window, for unscoped input) needs a fresh
  observation. Other apps stay usable, and queued calls run on the new driver.
- **Orphaned input.** A killed stdio process does not stop the daemon: it keeps
  typing the rest of the text. The recovering observation therefore waits until
  the window's tree has been unchanged for 600 ms (longer than the driver's
  slowest 200 ms keystroke spacing). If it is still changing after 8 s it
  refuses with `target-unsettled` / `rejected`, and the window stays blocked.
- **Daemon restart.** Electron main restarts a dead embedded daemon on the same
  socket, at most three times a minute, so a session's driver can reconnect.
- **Driver refusals are `not-dispatched`.** A structured driver refusal
  (`status: "refused"`, no delivery) becomes `native-<code>` / `not-dispatched`
  and no longer blocks the window. Previously every refusal was
  `native-driver-error` / `unknown`. This covers the daemon's `input_busy`
  refusal while it finishes orphaned typing.

Evidence: `scripts/test-native-driver-death.ts` kills a fixture driver in nine
places (mid-keystroke, partial typing, reads, queued calls, unscoped input,
failed restart, pre-dispatch refusal, orphaned and endless typing). It passed
20/20, and eight mutations each fail it or `test-computer-tools.ts`.
`scripts/test-native-driver-death-live.ts` (`MAKO_TEST_DRIVER=<driver>`) runs
the real driver against a background Cocoa view that logs every key event and
its posting process. It kills the stdio process mid-typing, then has the view
signal the daemon from inside a key-down handler, before the key up (8 ms
behind) is posted: first SIGKILL, then SIGTERM, the signal Mako stops it with.
On +mako.24 it passed six of six runs, one of them on the installed driver. The
observation waited 0.9–3.0 s for orphaned typing to settle. One key typed after
it landed exactly once, with nothing replayed; the other app kept working and
each replacement daemon kept the socket. The person's frontmost app never
changed.

Fixed in driver +mako.24 (September 26):

- **Held key after daemon death** (ledger B05). The daemon journals every key
  and mouse-button press beside its socket before posting it, and clears the
  entry once the release is posted. A replacement daemon on the same socket
  posts the missing releases before serving, and only to the same process
  (pid and start time). On SIGTERM or clean shutdown the daemon releases
  held input itself and deletes the journal. +mako.23 fails the live test with
  the key held; on +24 the next event for that key is its key up, from the
  replacement after SIGKILL and from the dying daemon after SIGTERM. Mako's
  startup sweep also removes journals left by dead hosts. Not covered: Linux,
  Windows, and a daemon that is not replaced because the restart budget is spent.
- **Driver false confirmation** (ledger B04). The driver confirmed an insert
  when the field *contained* the text, so typing text already present into a
  view that ignores the insert reported `confirmed` ("q" into "q" stayed "q").
  It now needs the value to change as an insertion would, or to gain an
  occurrence. An unchanged value confirms only when the replaced selection was
  the same text. Otherwise the driver falls back to key events. The live test
  types "y" into "zzyy" and gets "zzyyy".
- **Test-fixture focus theft (fixed earlier).** The first live fixture was
  executed directly, so AppKit activated it at launch. A person's typing landed
  in it twice. It now launches with `open -g` as an `LSUIElement` bundle. The
  test fails if a fixture ever becomes active or receives a key event posted by
  anything other than the driver's daemons.

Existing upstream test failures, unchanged by +24:
`protocol_session_test`'s `concurrent_multi_driver_isolation` and
`session_owned_cursor_state_is_independent` fail the same way on +23
(`get_agent_cursor_state` output does not match its schema), and
`protocol_proxy_recovery_test` leaves its daemon running after it passes.

Next within this gate: installed acceptance of the above, and capture/recovery
across installed extension replacement. The shared session extraction preserves
the tested exact-target and profile-wide rules.

Done when injected failures across public/raw paths retain the same truthful
outcome, require fresh evidence for the affected target and never replay input.
Unrelated targets remain usable; concurrent reads/actions cannot borrow a lease,
reuse stale refs or escape cancellation. Preserve coordination for native global
state. This also closes the older LC-14 contention/invalidation work.

## LC-23 — Preview isolation and installed browser rollout

September 24 media check: the installed app is now `5bfc1df4acea215e` (revision
`1d142af383e73b0539913c289664cdac03e9ec8f`). Its ASAR does not contain the binary
preview reader. The accepted `3c1d563e25a9bd78` evidence below refers to the earlier
build; this media task did not revalidate the intervening installation.

**Status: build `3c1d563e25a9bd78` passed installed package/host identity and
CLI/MCP browser/native acceptance.** The post-install JSON failure
was cached ASAR metadata after bundle replacement, fixed in the shared deployment
metadata reader with a regression test. Reconnect, cancellation, exact-value,
image and cleanup checks pass. Real Codex compaction through the default installed
host passes, including task interruption/resume and 1,006 foreground samples without fixture activation.
[Installed evidence](local-control-agent-repl.md#september-24-installed-acceptance-and-recovery).
The [live receipt](local-control-mcp-deployment.json) is `installed-validated`. This closes the scoped Mac/Aside + Codex installed milestone. Earlier rollout attempts below are historical.

Candidate `1e3322212fc98974` passed both packaged startup routes. Its idle-only
installer subsequently aborted because the shared host changed, without replacing
the app. The receipt is `release/preview-transport-20260923/install-state.json`.
A fresh probe now reports installed host `3e3f6a31a7970952` (built
2026-09-24T04:55:11.687Z); its packaged host/client modules contain negotiated
preview compression. The modules differ from the earlier candidate, so prior
measurements do not certify this exact build. Do not reinstall the older candidate. Aside
extension 0.3.2 passed 20 exact form jobs and 188 unchanged foreground samples,
then recording refused because the hidden tab supplied no frames. This does not
pass the recording/reconnect phases. [Evidence](local-control-preview-evidence.md#installed-aside-and-release-acceptance).

Candidate **`b1d91522d82480b1`** now passes both packaged startup routes, bundled
browser/native cursor encoding and **40** regular Aside form jobs with dialogs,
recording, interruption retention, reconnect and stale-handle refusal. All 259
foreground samples remain on Aside. This test loads the candidate's actual ASAR
modules and bundled encoders; it does not certify the old installed host.
The attempted installer verified host identity and never force-stopped work. Its
post-install packaged-media/Aside checks did not run. Read
`release/control-capture-20260924/install-state.json`; the attempt ended `not-installed` at 06:29 UTC after the shared host changed.
That attempt replaced no app. A later readiness check found installed app
`345bfd91c64009c6` on disk and an active shared host; the earlier installed build
identifiers above describe those earlier runs. Restart/rollout must be revalidated
against the current host, not silently resumed.
Only `installed-and-accepted` closes that deployment gate. A host replacement,
cancelled quit or deadline aborts without replacing the app.

The newer CLI-only candidate `15ebe10a1502342e` also passes 40 Aside jobs,
recording, interrupted artifact retention, reconnect and stale-handle refusal,
with 326 unchanged foreground samples. Its actual packaged CLI and worker pass
state/cleanup checks. See [CLI candidate evidence](local-control-cli-evidence.md).
It has not replaced the default installed host.

**Fixture desk (A09), September 26: enforced and tested locally; not installed.**
`npm run desk:fixture` (`electron/start.mjs --fixture`) starts a host on a
`fixture-<checkout>` profile with `MAKO_FIXTURE_DESK=1` and serves only the web
page; it refuses `--shared` and non-fixture profiles, and refuses to serve if the
host does not report `fixture: true`. The boundary is in the host, not the page:

- Every host call, from every transport, passes one function in
  `electron/ipc/register.ts`. That covers the host's own hidden desk windows,
  which agents drive and which call the host over in-process IPC (they never
  touch the socket or the dev proxy), plus Electron windows and pages on the
  socket. A fixture host refuses anything outside the 19 reads in
  `electron/contracts/fixture-desk-policy.ts` with `fixture-refused`, before
  the arguments are parsed. The only socket-only exception is
  `lifecycle-command`, which the launcher uses to replace an outdated fixture
  host; it stops only that host.
- The Vite proxy refuses the same channels a second time, plus bodies that name
  no call, and forwards exactly the bytes it checked.
- The host turns off relay work, public version readers and automation runs, and
  a checkout never owns the catalog login job. It still reads the real
  conversation catalog through the shared read-only indexer, so real titles and
  transcripts are visible.
- The desk registration and `control.browsers()` mark it `fixture: true`, with
  guidance that it only reads. The installed build's older runtime rejects the
  new registration field and does not list fixture desks, so it fails closed.

`scripts/test-fixture-desk.mjs` (`npm run test:fixture-desk`) runs a real
Electron fixture host. Provider, write, git, terminal, relaunch, archive and
unknown calls with garbage arguments are refused on the socket, the page proxy
and a hidden desk window driven over the desk protocol; terminals and automations
are unchanged afterwards; reads and `boot` still run; the host quits through its
lifecycle. Disabling host enforcement fails it at the socket; removing only the
in-process check fails it at the hidden desk window. The real launcher was also
checked: it served a fixture page (live-start and list-models refused, threads
served), registered a fixture desk, and the interface rendered. Remaining: install,
then an agent previewing a UI change through the fixture desk. Seeded fixture
conversations in place of the real catalog are not built.

Next: verify/install the latest exact host/extension builds after active work safely ends.
Keep ordinary regular profiles and saved-browser routing; explicitly exercise
worker restart, extension reload, detach, foreign frames and unavailable profiles.

Done when fixture preview attempts cannot invoke providers, writes or other real
app mutations; ordinary live targets remain clearly identified. Installed Aside
and Chrome must pass long saved workflows with screenshots, recording, dialogs,
reconnect and no silent debugging fallback. Verify real opener/named-window flows,
retained child tabs/results, audio cleanup and download completion. Arbitrary
page-triggered extension downloads still need attribution/completion support.

## LC-24 — Native accuracy and background behavior

**Status: partial; safe refusals remain part of the contract.**

September 25: `+mako.22` fixes right/double-click recording-context propagation.
Three isolated runs retain cursor events and decoded artwork. Two keep Aside
foreground; one sees the fixture foreground for 44 samples, with insufficient timing
to assign a cause. The phase-instrumented repeat passes, but does not erase that
counterexample. Follow-up adds background-only fixture ordering and bounded
activation/mouse diagnostics. Two actual installed-session cursor/value jobs pass;
a later read exposes live implicit-session idle eviction, fixed by `+mako.23` with
transport-scoped lifetime. The coordinated foreground repeat measured Dock, not
Mako, so it cannot close the Mako-focused gap. [Cursor/focus evidence](local-control-media-fixes.md#native-cursor-propagation).


Current continuation: fixed modified native keys dropping their addressed field.
The previous frozen engine selected a decoy field; source and signed candidate
`0d02dc53d0a315ff` each pass three exact-field rounds with unchanged decoy/focus.
The public API now supports a single native middle-click when the driver advertises
it. A resized-screenshot gesture run passes real AppKit events and cursor recording
(671 frames, 19 pointer events, 148 unchanged foreground samples). Old drivers and
stale refs refuse before dispatch. The candidate also passes sandboxed Save As,
three cancellations and one independently confirmed write. No native-driver update
or installed-desktop replacement occurred. [Evidence](local-control-input-target-evidence.md).

**User scope decision:** defer the Japanese physical test as overkill. Do not ask
the user to repeat the completed English trial merely to unblock other work.
This does not establish IME correctness or waive other physical-input questions.
Proactive focus prevention, cross-process raw input, broader gesture/compositor
coverage and installed rollout remain active. CLI discovery/adherence is now an
additional priority in LC-29.


September 24 physical-input continuation: ordinary English typing and IME are now
separate modes of `scripts/test-native-human-input.mjs`. The English trial retained
the exact two-line text during eight background edit/save jobs, with 78 keydowns
overlapping those jobs and no foreground change during the test interval. It ran
the installed +mako.17 driver through the CLI. Human attestation is pending; this
does not establish IME composition or proactive prevention of deliberate activation.

September 24 continuation: shared observation filtering now preserves in-window
popup/context menus. Three real AppKit popup selections passed through scoped CLI
locators without activation notifications. General menus/dialogs remain unproven.

September 24 capture/dialog continuation: +19 passed bounded settling, background
click/right/middle/double-click/scroll and cursor recording (862 frames, 19 pointer
events, no sampled foreground change). Background drag still refuses. A real file
sheet can open despite AXPress acknowledgment error -25204. Shared-engine errors
now explicitly preserve that uncertainty. Unavailable sheet observations produce
`observation-unavailable`, block further input and never become empty successful
reads; malformed snapshots produce `invalid-driver-response`. The CLI regression
passes against the installed +19 driver and frozen source runtime. Parent-tree
Cancel remains refused because exact sheet ownership is unresolved; this is a
failure-handling pass, not completed dialog control. These engine fixes pass source and packaged CLI acceptance in signed candidate
`33153e3c6176bd87`; the desktop app replacement remains pending.

September 24 file-sheet continuation: **+mako.21 is signed and installed for new
Mac driver launches**. Shared bounded discovery resolves the panel's own native
window ID for observation and input. The installed-driver CLI passes three
cancellations and one exact file selection, independent AppKit confirmation,
unchanged foreground, untouched decoy/parent controls and stale/cross-window
refusal. Ordinary settling, menu selections and cursor recording also pass;
377 Mac unit tests and final full lint pass. Existing daemons were not restarted.

Panel coverage remains honestly incomplete because AppKit returns attribute
errors. This validates explicit refs, not strict whole-panel locator uniqueness,
raw sheet keys, Save As or cross-process ViewBridge dialogs. Proactive window-tag
experiments did not establish prevention and shipped no change. Physical typing
coordination remains unanswered. Broader compositor gestures remain open.
[Full evidence and retained failures](local-control-file-sheet-evidence.md).

September 24 bounded-read continuation: sandboxed Open and Save As each pass
three cancellations and a confirmed file operation, with Apple's separate panel
service identified, unchanged foreground, untouched decoy/parent and stale-ref
refusals. A real expanded Save panel exhausted the 1,000-node budget before its
buttons. Native `observe({maxDepth:5})` now bounds traversal; it returned 83–84
lines with a 244 ms median in the final run. Coverage remains incomplete, and
unsupported drivers/browser targets refuse the option. This is source-engine
acceptance with installed +21, not a new desktop rollout.

The same depth contract passes labwc, Weston and KWin with twenty background
form jobs each on Linux +19. Long UTF-8 socket paths now use private short
endpoints, with startup/crash cleanup and conservative orphan reaping tested.
The existing Docker image was reused; test containers were removed. Core/engine,
packed-consumer checks and full lint pass.
[Evidence, failures and exact limits](local-control-dialog-depth-evidence.md).

Next: proactive Mac focus protection, raw cross-process key/pointer delivery and other dialog families; clipboard
consumption/collision handling; remaining physical-input confirmation. Japanese testing is deferred by user choice; do not treat it as a prerequisite for the other work.
Broaden Electron/Qt/rich-editor coverage. The explicit Terminal GUI job now passes:
background launch, native command typing, high-level Return, independent output
read, screenshot and owned-window cleanup. All 82 foreground samples stayed on
Aside. A capability-only fix ignores explicitly off-screen document rows while
unknown/on-screen competitors and the driver's final guard still refuse. Recording
can introduce an AX dialog that blocks keyboard delivery; no title/size exception
was added. Keep direct shell execution as a separate exact-output route.
Finish native observation lineage,
invalidation, bounded scoped reads and busy/progress readiness without interpreting
quiet as completion. Carry forward LC-09/10/13/15/16 where evidence remains narrow.

Done per route with independently saved exact values, correct window/PID, physical
input retained, observed focus history and complete interruption reporting. Match
cursor traces to actual gestures, including untested touch/pinch/drag routes.
Physical-input tests require a participant; generated Unicode is not IME evidence.
The actual reference Linux executable remains unavailable and is a comparison gap,
not a reason to stop testing Mako's own implementation.

## LC-25 — Linux backend and cloud coverage

**Status: standalone lifecycle implemented; platform coverage is incomplete.**
[Runtime](local-control-runtime.md) and [contributor CI](local-control-ci.md).

September 24: +mako.19/current CLI passes on native AMD EC2. The portable runner's
X11 jobs/recordings and Sway normal, 150%, and 150% plus 90-degree rotation all pass.
Both standalone CLI workflows and eleven lifecycle scenarios pass, with retained
media decoded and selected images inspected. The VM and temporary network/key
were removed. [Evidence and limits](local-control-native-validation.md).

September 26: driver +mako.24 with the current engine repeats this locally.
ARM64 passes X11 jobs, recording with gestures, Sway at 100%, 150% and 150%
rotated, labwc/Weston/KWin (twenty jobs each), GNOME 46 (capture, gestures,
recording, ten hidden jobs) and, in the runtime image, both CLI workflows and all
eleven lifecycle scenarios. Translated x64 passes the five acceptance suites; that
is not native x64 evidence. The first run exposed a runner bug: containers run as
the calling UID, which the image usually lacks (GitHub-hosted runners use 1001),
so D-Bus refused to start and every suite failed. The September 24 EC2 pass
worked only because its user was UID 1000. The start scripts now give an unknown
UID a passwd entry through `nss_wrapper`; both local +24 runs used UID 501.
[Evidence](audits/2026-09-26/linux24/README.md).

Current-version continuation: KWin 6.3.6, labwc 0.8.3 and Weston 14.0.2 pass
twenty ARM64 background jobs each after fixing current AT-SPI `button` role
normalization. Capture/gesture support is not established by these form jobs.

September 24 bounded-read checks: current shared engine + Linux +19 passes
`maxDepth:1` on all three compositors, keeps omitted descendants incomplete and
then completes all sixty background form jobs. This adds read-contract coverage;
it does not enable unverified gestures or capture.

September 26, native x64: +mako.24 with the current engine passes on a
disposable EC2 instance (8 vCPU AMD EPYC 9R14, Ubuntu 24.04, kernel 7.0 aws):
the five acceptance suites (X11 jobs and recording, Sway normal, 150% and 150%
rotated), the runtime image build, the native GTK and Chromium CLI jobs, and all
eleven lifecycle scenarios. The instance ran in an isolated VPC with no IAM
profile, with instance metadata disabled and checked before any code was copied,
and SSH open only to the operator's address; only prepared payloads were copied.
The instance, key, security group and VPC were deleted afterwards and the
deletion was confirmed.
[Evidence](audits/2026-09-26/linux24/x64-native-ec2/).

September 28, native x64 again, same recipe and machine type, because the
contributor workflow is still unpublished. It uses the current engine,
byte-identical to candidate `13a82042e7e655bd` for the CLI, session server,
browser service and encoder worker. The queued `973fabfc73ce3aa3` differs only in
a lint refactor of the CLI and session server; `test:control-cli` passes on it
locally. All suites pass: desktop acceptance with 10
hidden jobs, the runtime image, both CLI workflows (including the public
scoped-edit examples) and the eleven lifecycle scenarios. Every AWS resource was
deleted and checked by ID; no volume remained.
[Evidence](audits/2026-09-28/linux24/x64-native-ec2/README.md).

Next: run the contributor workflow once published (it exercises the calling-UID
fix on GitHub's UID), then extend compositor/version and real display/GPU coverage. AMD x64 Sway now
has scale/rotation and hidden-job evidence. ARM64 Sway additionally has load
evidence; GNOME 46 has
scoped capture/input evidence; Weston/labwc have semantic hidden-job evidence,
not equivalent capture/gesture support. KWin 5.27.11 ARM64 now passes twenty exact
background form jobs, independent Save counts, unchanged duplicate-name cover
and focus history, plus unsupported raw-input/capture refusals. KDE capture,
gestures, Plasma 6 and other versions remain unverified.

Done per supported target with fresh isolated desktops, exact identity/value oracles,
scaled/rotated geometry, modal/popup behavior, covered/hidden capture where promised,
recording, restart and held-input cancellation. Verify whole process-group cleanup,
private profiles/runtime directories and retained artifacts. Keep contributor runs
secretless with pinned actions and read-only permissions; public CI execution is
separate from the locally prepared workflow and completed EC2 acceptance.

## LC-26 — Packaging, dependency size and stale code

**Status: initial cleanup and target packages tested; further reduction open.**
[Architecture, sizes and target matrix](local-control-packaging.md).

**September 25 streaming cleanup — deployed in signed build `9b696b0d9525e7e9`; installed packaged checks pass.**
Traced LC-21's current callers and removed unnegotiated Brotli response decoding, staged-browser post-stop
encoding branches, an obsolete Electron media-resolver test and FFmpeg's unused
concat demuxer (recipe 4). The container-recovery audit now uses the shared encoder
policy. Native overlay/pass-through, Linux software encoding and PNG/viewer decoder
fallbacks have live callers and remain. Preview/recording/recovery suites, build,
typecheck and full lint pass (five existing React warnings). Recipe 4 is validated
and promoted to the standard local media directory; 71.16 MB of obsolete temporary
build copies were pruned with provenance preserved. This cleanup postdates signed
candidate `b5ec839840ea7ab0` and is included in installed build `9b696b0d9525e7e9`.
Strict signature, running-host identity, matching media modules and packaged
browser/native codec checks pass. LC-21 retains the loaded-recording and native
cursor failures from [installed acceptance](local-control-installed-media.md); the
[follow-up fixes](local-control-media-fixes.md) have separate source/private-driver evidence.
[Caller inventory, retained paths and evidence](local-control-streaming-cleanup.md).

September 25 follow-up audit (local): LC-21 recorder, preview decoder/painter and
runtime exports have no dead code; unused-looking exports are used in their own
files or are package entrypoints. The real stale items were behavioral. The recorder's
backlog cliff is fixed under LC-21. `test-control-preview-electron.mjs` decoded
timestamped video at a forced constant rate and falsely failed on frame count; it
now decodes with `-fps_mode passthrough` and passes. Six media scripts are wired to
no suite or document: `test-control-preview-electron`, `test-browser-cursor-visual`
(both pass), `test-control-preview-e2e` (needs a dev server on port 5174),
`test-browser-capture-live`, `test-packaged-control-recording` and
`audit-capture-projects`. `test-control-preview-e2e` also runs against
`npm run web` with `MAKO_TEST_ORIGIN=http://127.0.0.1:5173/` and now checks
displayed-size painting at DPR 1 and 2. Unwired tests rot, as the decoder case shows.
Wired suites rot too: `test:mcp` had failed since September 22 on two stale
expectations (optional `browser.open` browser; task-scoped `mako-control` absent
from the global registry). Both were updated to the current contract on September 26. Wire the two
passing ones into `test:control-recording` once the other contributor's
`package.json` changes land. Retire the rest only after checking their owners.

September 23: the signed ARM64 candidate is 662,787,567 installed bytes; 1,077
frozen build files and 664 imports verified. Packaging now derives workspace
FileSets from the canonical release manifest, fixing the omitted `control-runtime`
mapping and preserving JS/license-only Control payloads. Both packaged startup
routes passed. Other target and actual default-host rollout claims remain separate.

The latest signed ARM64 candidate `a0c8c955359372bb` is **662,922,799 bytes**,
with 684 resolved imports. Media recipe 2 passes packaged browser/native
cursor encoding without Homebrew; the packager rejects a stale recipe/source
manifest even when its old binary hashes still match.

September 24 Docker audit: normal runs reuse images, but 72 stopped Mako test
containers retain 7.49 GB of writable data; seventeen Mako image tags remain.
Cargo/target/media volumes retain ~6.39 GB for rebuild speed. The global builder
reports 25.85 GB private cache across projects. Its full disk report fails on a
missing snapshot; no reliable total or global prune is claimed. The new compositor
runner saves evidence and removes each test container, reusing one dependency
image. [Evidence and remaining cleanup](local-control-native-validation.md#local-docker-retention).

Next: align the Rust build image with the pinned driver toolchain to avoid repeat
downloads; bound image/build-cache retention, retain unique historical evidence before
removing stopped test containers, and diagnose the missing Docker snapshot.
Measure full installed bytes and cold start per browser/native/mixed cloud
image and desktop target, not just source payload or driver size. Audit a reduced
native build profile by dependency/section size before removing upstream code.
Keep exact public dependencies, target-specific media, source/licenses and provenance.
Verify `.pyc`, caches, generated media binaries and unrelated providers stay outside
source/payloads; prune orphaned compiled modules and retired callers.

Done when each supported artifact has reproducible build inputs, correct architecture,
size breakdown, no private credentials or wrong-target dependencies, and runtime
capture/input/lifecycle acceptance. Any reduction must preserve those results.
Generic build declarations do not certify Intel Mac, Windows or Linux desktop releases.

## LC-28 — Reusable packages and public entrypoints

**Status: Node runtime extraction implemented; clean packed-consumer and ARM64 jobs validated locally.**
[Ownership and imports](package-boundaries.md). Session search is explicitly out
of scope; the user approved Node packages plus composable CLIs.

`@mako/control` remains lightweight. `@mako/control-runtime` now owns the shared
session/browser/native/capture implementation and CLI entrypoint. Desktop,
extension, build and deployment callers use the new package; old source and
compiled entrypoints are removed. Standalone configuration is explicit, worker
paths resolve within packages, and engine identity survives relocation. Strict
external TypeScript checks also exposed and fixed invalid inferred observation
declarations. A pending native connection is disposed when its owner closes.

`npm run test:control-packages` verifies real archives without workspace links,
public types, separate CLI processes sharing worker state, capture, correction
errors, artifact spill, lifecycle and release boundaries. Real ARM64 Chromium and
GTK jobs preserve targeting, media and cleanup. See
[extraction evidence](local-control-package-evidence.md) for exact scope,
measurements and limitations; LC-26 owns full installed size per target.

Next: public distribution/versioning, installed desktop/Aside acceptance and
publishing/running the contributor workflow. Current native AMD package/CLI
acceptance passes; that is separate from a GitHub workflow run. Physical input and broader
compositor coverage remain in LC-24/25.

## LC-27 — Complete-job accuracy, performance and harness evaluation

**Status: substantial fixture evidence; broad comparative acceptance remains open.**
This is the continuation of LC-12, not another API implementation milestone.

Next: repeated held-out tasks with duplicate controls, virtualized content, rich
editors, popups, multiple windows, downloads, long recordings and interruptions.
Run via MCP in multiple harnesses; retain fresh-agent mistakes as cases.

Done for a declared matrix when independent outcomes establish completion and false
confirmation rates, focus/input interference, recovery, human interventions, model
round trips/context/image bytes and p50/p95 task latency. Measure displayed frames and p95 frame gaps separately
from capture/output fps; check that instrumentation does not distort a candidate.
Use equal-resolution comparisons alongside ordinary defaults. Compare the same workload
and builds before/after changes. A reference parity claim requires matched reference
runs; symbols, marketing fps and synthetic transport timings are not substitutes.

## LC-29 — Agent discovery and MCP integration

**Status: Mac/Aside installed acceptance is complete, including MCP/browser reconnect, cancellation, and default-host Codex compaction/interruption/resume. Broader provider/platform and comparative usability coverage remains open.**
[Discovery audit and accepted design](local-control-cli-discovery.md).
[Implementation, retired-MCP comparison and test evidence](local-control-agent-repl.md).
This supplements LC-20 and LC-27. MCP is the primary Mako agent interface; the CLI
is a thin optional consumer for external users. All control logic stays in the
shared TypeScript SDK/engine. The user superseded the CLI-only decision: add
a new persistent-JS MCP adapter over the shared session, not the retired
status/help/exec tool collection. [Accepted design](local-control-cli-discovery.md#accepted-design-sdk-cli-and-persistent-js-mcp).

Local implementation now exposes `js` and `js_reset`, with persistent bindings,
first-use/focused docs, explicit images and shared ownership. Tests pass for real
MCP-over-HTTP cancellation, revoked grants, package consumers, stale refs across
interfaces and reset without target cleanup. No new dependency or CLI subprocess
was added. Candidate `3c1d563e25a9bd78` includes the re-review fixes and passes packaged HTTP MCP acceptance; it is installed, with installed browser/native MCP and default-host Codex compaction verified. See the installed acceptance section for scope and remaining cells.

Separate whether the agent discovers the available tool from whether it follows
its targeting, observation, verification and recovery rules. Current startup
injection now advertises the unified MCP `js` tool, with the CLI as an optional
file-pipeline interface. The earlier CLI-only injection linked to `--help`. Prior fresh trials received the CLI explicitly,
so their success does not establish discovery during an ordinary user task.

The new trials give only the outcome and target; actual endpoint requests prove
MCP use. Codex/Claude browser runs used 9/7 calls; Cursor used 13. Native two-turn
runs preserved exact Unicode/whitespace and never sampled the fixture foreground.
Cursor completed with three recovered JavaScript mistakes, so native zero-error
usability remains open. The review caught and fixed ACP dropping the control
endpoint after negotiation and an idle worker error killing the entire session.
The latter is reproduced against superseded candidate `1226a367de0c1b11` and
passes the new candidate while retaining its tab. Failed runs and test-runner
limitations are preserved in the [review](local-control-agent-repl.md#september-24-re-review-and-fresh-agent-acceptance).
The Japanese physical IME test remains deferred at the user's request.

Direct review of default/dev Mako session databases found concrete old-MCP
connection guessing, `code`/`source` mismatch, inconsistent query keys and target
recall confusion. [Session evidence](local-control-cli-discovery.md#session-evidence-checked-directly-on-september-24)
records the session/block IDs, current mitigations and limits. Add disconnected
browser recovery, obsolete API history and reset/compaction recovery to ordinary
agent trials. Inspect result envelopes rather than trusting `completed` labels;
measure inventory/help output cost. Do not attribute these old-MCP failures to CLI
migration or count source-search keyword matches as control use.

Next:

Current LC-21 evidence: [installed media acceptance](local-control-installed-media.md)
records build `9b696b0d9525e7e9`, ordinary success and two remaining failures.
[Mac hardware recording](local-control-mac-hardware-recording.md) retains earlier
source-host quality/resource measurements; [recording efficiency](local-control-recording-efficiency.md)
retains software failures. [Linux streaming](local-control-streaming.md#september-24-isolated-prototype-measurements)
retains prototype results pending the cloud-environment definition.

1. Media rollout and preview-under-contention work are tracked in the
   [delivery order](#delivery-order) and LC-21; this list covers agent discovery only.
2. Extend the completed matrix with Grok browser and Linux MCP, plus provider
   interruption/resume, compaction, fresh bindings and child-agent discovery.
   Preserve exact source/candidate/installed identities for every result.
3. Improve the remaining observed usability costs, including Cursor's recovered
   JavaScript mistakes and unnecessary help. Use held-out jobs and matched baseline
   runs to measure invalid calls, help bytes, first correct action, total context,
   exact completion, latency and unintended input. The few successful runs above
   are not a statistical comparison with the retired MCP or ChatGPT.
4. Preserve shared SDK/engine invariants during rollout: target leases, exact refs,
   explicit images, cancellation, unknown outcomes and no automatic input replay.
   The regression suite now covers idle worker failure without losing the task.

Done for a declared provider/build matrix when complete tasks improve discovery
and rule adherence without sacrificing exact outcomes, latency or context cost.
Keep matched baseline/candidate failures; passing subprocess tests or better prose
alone does not close this item. No general MCP-versus-CLI regression or superiority
claim has yet been established.

## Scope decision from the Replicas review

Accepted 2026-09-23: borrow low-latency capture/transport techniques now for local
and remote browser/computer use. Reuse the existing engine with platform/backend
adapters; do not introduce a third control system. Updated September 25: implement
Mac hardware encoding now, and define the Linux cloud-agent environment before
selecting or implementing its streaming backend. The main harness remains the action caller. Full human-control/takeover
features and their ownership-policy interview are deferred, not prerequisites.
[Architecture and experiment scope](local-control-streaming.md#accepted-scope-one-engine-multiple-backends).

## Maintaining this plan

Update the relevant workstream and issue entry in place. Record code/test evidence
and separately record the exact deployed host, extension, driver, OS/backend and
browser. Only move an issue to accepted for its stated scope after its closure
check passes; a diagnosis or documentation change alone may leave UX work open.
Preserve failed runs. Put detailed chronology in [history](local-control-history.md)
and measurements in audit artifacts, keeping the current map readable.

Before committing Local Control source, run `npm run lint`, not only the
typecheck and suites. Its `lint:anti-slop` step runs while a local update
compiles, and on October 1 it failed an update with 73 errors from these
packages. The rules ban `typeof`, conditional empty-object spreads, `unknown`
parameters other than `cause`, and type assertions without a `SAFETY:` comment.
Decode values with Zod instead. A program's values can come from the REPL's own
realm, where `instanceof` checks fail.

The installed app runs control workers in Electron's Node mode, and the repo
runs them under Node. Anything a worker spawns must not inherit
`ELECTRON_RUN_AS_NODE`, and only an installed or packaged test shows a
mistake there.

Original LC-01–07 are the completed API replacement. LC-11's no-image-read/schema
cost fixes are tested. LC-18's explicit connect and LC-19's request-shape fixes are
implemented; installed/fresh-agent proof belongs to LC-22/23/27. Other original IDs
remain in history and are carried into the workstreams above, not silently deleted.
The user explicitly prioritizes maintainable abstraction, debuggability and fast
feature iteration. The architecture contract therefore requires one owner per
resource, correlated bounded diagnostics, fault injection at shared seams and
backend/transport change tests. Interface count alone is not progress.
LC-28's Node-package/CLI decision is settled; session search is out of scope. Physical
input participation, safe installed-app handoff and unavailable comparison hardware
or binaries are specific acceptance dependencies, not blanket project blockers.

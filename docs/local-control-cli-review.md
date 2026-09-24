# Local Control CLI review — September 24, 2026

Follow-up: [modal fixes, revised help trials and signed-package acceptance](local-control-cli-modal.md). The open findings below are the original review state.

The CLI completed both fresh-agent jobs correctly. This does not establish equal
or better computer/browser use than ChatGPT. Learning overhead remains high,
modal clicks need investigation, and the native/platform gaps in Wayfinder remain.

## Method and versions

Two agents received only the public task CLI, fixture location and desired result,
without repository internals or the fixture's implementation. One used the regular
Aside profile, the other a disposable AppKit window. They used public help and
returned files; neither used private sockets, raw CDP or another automation tool.
The owner independently inspected submissions, native state and media.

These live jobs used signed candidate `15ebe10a1502342e`, engine
`3c76b0f7ea300e243037712bc7e906746cc13a7d02e2c68449c6e303cfbd5053`.
The error/help fixes below are newer source changes. The old candidate does not
contain them, and the installed app was not replaced. A new package must be built
and accepted before rollout.

A third blinded agent ran the same browser form through the available CUA tool.
It exposed Chrome only; Aside was unavailable. This is a local tool comparison,
not a ChatGPT cloud benchmark or a same-browser performance comparison.

## Fresh-agent outcomes

| Job | Outcome | Calls and learning cost | Independent evidence |
| --- | --- | --- | --- |
| Mako / Aside | Completed; all CLI calls exit 0 | 31 calls, 18 help/API calls; 27,601 help bytes, 46,719 total stdout bytes; 13.182 s summed command time | One trusted Shipping submission of `  Zoë 東京 🧪 00123  `; agent verified Billing unchanged, accepted confirmation once, closed own tab; PNG and H.264 decode valid |
| Mako / AppKit | Completed; all CLI calls exit 0 | 27 calls including initial uninstrumented help; 16 logged help/API calls plus initial help; 25,987 logged stdout bytes, 11.647 s logged command time | Proof and Result both exactly `  Renée 日本語 🧪 é  `, including decomposed accent and spaces; four background accessibility mutations; screenshot and video decode valid |
| Available CUA / Chrome | Interrupted; final success not verified | 14 tool calls, two explicit help calls; bootstrap docs also supplied but byte count unmeasured; 109.2693 s summed tool time | Exact Shipping input observed with Billing unchanged before Save. Save once, confirmation acceptance invoked once. Subsequent observation, screenshot and close timed out on focus emulation |

Native Verify appears once in the agent's command log; the fixture independently
verifies the result but has no activation counter. The reference trial produced
no additional fixture submission before teardown. Do not infer which internal
step failed from that alone. Its final inventory still showed the created tab;
a later scoped cleanup check found that exact tab already absent. The owner then
stopped its fixture app, sessions, driver and HTTP server.

Foreground sampling across the combined run saw multiple apps. The fixture app
PID never appeared, but human activity and the Chrome reference overlap: this is
not controlled evidence of uninterrupted typing or universal focus isolation.

The browser PNG was 1383×162. Its recording was 1280×804, 14.3 s, 143 decoded
constant-rate frames, 41 distinct decoded hashes and eight captured timeline
frames. The native PNG/video were 480×232; video decoded all 635 frames over
21.167 s, while the receipt counted 625 source frames over 21.198 s. Constant-rate
encoding can repeat source frames. These small/static tasks do not establish
capture throughput, 60 distinct fps or sustained media performance.

## Problems found and changes

1. **Post-dispatch errors could invite replay.** A successful engine operation
   followed by malformed result parsing or failed image publication was reported
   as `invalid-request/not-dispatched`, exit 2. It now reports
   `result-unavailable/unknown`, exit 4, with instructions to inspect the same
   session rather than replay. Typed engine faults retain their original meaning.
   Recording receipts are validated before publication. Six subprocess regression
   cases cover open, claim, exec, recording and image failures, with exactly one
   dispatch each and no result published on these failures.
2. **Cancelling Linux startup looked like bad input.** Real SIGINT/SIGTERM during
   backend startup reproduced exit 2. Both now return `cancelled/unknown`, exit
   130. The CLI requests shutdown; the test independently verifies worker-group
   exit, supervisor cleanup and removal of private runtime/session files. The
   error does not claim that CLI exit alone proves cleanup.
3. **Help did not bridge target files to persistent handles.** `exec --help` now
   shows `control.tab(TARGET_JSON)` and a composable jq/stdin recipe. Runtime
   examples explain existing targets; `handles` is a focused topic. Dialog help
   specifies accepted values and inspection before response. Native role names,
   file image output, source/encoded frame counts and command lifetime are
   explicit. Removed stale public cell/display instructions. These edits have
   not yet passed another fresh-agent learning-cost trial.
4. **Modal click latency remains open.** The Mako edit/click/dialog inspection
   command took 6.135 s; its cursor stayed pressed for about 5.005 s. Source
   `BrowserService.clickAt` waits up to five seconds for mouse-release
   acknowledgement and retries release on failure. This matches a possible
   mechanism, not a proven causal trace. Instrument dispatch/ack/dialog ordering
   and distinguish release cleanup from action replay before changing it.

The repeated help reads are a failure of the current learning-cost goal even
though all Mako operations succeeded. Fixing prose alone is not acceptance.

## Comparison with the existing reference audits

The supplied `codex-cu-reference-evidence.md`, `codex-cu-layers-3-4-deep-dive.md`
and `chrome-chatgpt.md` remain the detailed reference record. They cover different
layers and evidence strengths; native symbols are not runtime guarantees.

- Mako's files/stdin, separate-process shared state, exact values, scoped targeting
  and explicit assertions worked in these jobs. They are useful design strengths.
- The reference's initial documentation and typed dialog object required fewer
  explicit help lookups here, but its complete bootstrap byte cost is unknown.
- The reference failed this modal workflow on its available Chrome backend.
  One failed trial does not establish Mako's general superiority.
- The audits describe richer native synthetic focus and focus-steal protection,
  cross-process dialog handling and clipboard consumption checks. Mako's general
  proactive protection, physical IME/concurrent typing and platform evidence
  remain incomplete. Static symbol evidence cannot fill those acceptance gaps.
- Historical reference trace timings and today's CLI timings have different
  workloads, browsers, startup and image costs. Do not calculate a speedup.
- The reference Linux executable and actual isolation internals remain unavailable.

## Validation

`npm run test:control-cli` passed, including six publication-failure regressions,
input contracts and desktop lifecycle/owner cleanup. The Linux startup test passed
both SIGINT and SIGTERM with network disabled and coherent current package mounts.
Full `npm run build` passed. An initial attempt encountered a sessions-package
`catalogIdentity` type mismatch while concurrent sessions work was changing;
the repeat passed without changes to that work. Full lint passed with five existing
React/TanStack warnings and no new Oxlint warnings. `git diff --check` passed.
No new signed candidate or installed rollout is claimed for these source fixes.

## Reproduction and next gates

Run `npm run test:control-cli` for CLI, input, publication-failure and desktop
lifecycle checks. `scripts/test-control-cli-start-cancel.mjs` runs inside the
Linux runtime image. When testing newer source with an older image, mount both
compiled `packages/control-runtime/dist` and `packages/control/dist` at their
matching `/opt/mako-control/packages/…/dist` locations; a single-file overlay is
not a coherent engine. No provider credentials or network are needed.

Raw agent traces/media remain in `/tmp/mako-cr-MPSe9Q`; they are not durable and
include browser inventory. This sanitized report is the durable record. Baseline
and fixed publication logs are `/tmp/control-cli-output-{before,after}.log`;
Linux cancellation results are in `/tmp/mako-start-cancel-evidence.LsG9CF` and
`/tmp/mako-start-cancel-fixed.C3iio4`. Do not commit raw inventories or session files.

Next: resolve modal latency; repeat fresh jobs against revised help with measured
round trips/bytes; rebuild and accept the exact candidate; complete installed
Aside/native and x64 gates. Streaming remains paused until CLI release acceptance.

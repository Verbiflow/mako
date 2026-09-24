# CLI modal recovery and packaged acceptance — September 24, 2026

The five-second modal-click delay is fixed in candidate `7b0a2c623f935da0`.
Both fresh agents completed their browser/native jobs through that signed
package. Deployment is queued through Mako's idle lifecycle; the live
[deployment receipt](local-control-cli-deployment.json) records whether installation
and installed checks have actually completed. A queued update is not an installed pass.

## Which implementation is which

Mako browser control is our shared browser engine, using the Chromium extension
for regular profiles and explicit CDP for supported owned targets. Mako native
computer control uses our shared engine over the patched open-source Cua driver.
OpenAI's reference CUA tool is a separate implementation used only for comparison.
Mako does not call that reference tool to control applications. The driver's
private protocol is separate from the removed public Local Control MCP adapter.

## Root causes and fix

The renderer paused inside a confirmation dialog before acknowledging
`mouseReleased`. Mako waited five seconds, sent release again, then treated the
second acknowledgement as success. Recording feedback also waited for the
acknowledgement, incorrectly leaving the cursor visibly pressed.

There was a second failure without a recording holding page focus: action cleanup
sent `Emulation.setFocusEmulationEnabled(false)` while the modal still paused the
renderer. Its timeout detached the tab and replaced the useful dialog error with
a cancellation error. The explicit answer then failed because ownership was gone.

The engine now listens for a dialog event on the exact session before dispatch.
For an explicit-answer policy it stops waiting immediately and returns
`dialog-open/unknown`. It does not claim the click succeeded or replay it. Mouse
and keyboard presses each get one independent release attempt on interruption.
Auto-answer policy still requires the real acknowledgement. Late replies cannot
clear uncertainty; the agent must answer the dialog and obtain fresh observation.

Focus restoration waits for the modal to close, while session teardown still
resets or detaches. Consecutive dialogs preserve the new pending dialog. Capture
and action focus holders share the same lifecycle. Cursor feedback follows
input dispatch, separately from completion; release clears the pressed state.
Both recording and extension-overlay paths are corrected. The overlay code still
needs installed extension-update evidence; host tests alone do not establish it.

## Measurements and accuracy

A paired regular-profile Aside fixture, with the same lease focus policy, measured:

| Measure | Before | After |
| --- | --- | --- |
| Click return | 5,016.6 ms | 313.2 ms |
| Mouse releases sent | 2 | 1 |
| Result at dialog opening | Apparent success after retry | Explicit unknown interruption |
| Independent saves after explicit acceptance | 1 | 1 |

The action-focus variant returned in 331.4 ms, retained its attachment, and saved
once after confirmation. Those times include browser dialog presentation. They
measure this local fixture, not general page latency or a ChatGPT speedup.

Regressions cover dialogs on mouse press/release and key down/up, immediate
open/close, consecutive dialogs, a different tab's dialog, automatic answers,
pre-dispatch and post-press cancellation, late replies, rejected release without
retry, persistent uncertainty, deferred focus restoration, capture ownership and
teardown. Extension tests cover feedback before acknowledgement, release state
and zero hidden-tab feedback commands.

## Fresh agents using the immutable package

Agents received a public task CLI and a task, without source, private transport
access, workaround instructions or another agent's report.

| Job | Result | CLI / help calls | Evidence |
| --- | --- | --- | --- |
| Aside form | Passed | 13 / 2 | Scoped duplicate controls, exact `  Zoë 東京 🧪 00123  `, one trusted save, explicit confirmation, Billing unchanged, scoped image, recorded temporary edit/restoration, close and public absence check |
| AppKit form | Passed | 12 / 3 (two distinct help views; one repeat for logging) | Exact `  Renée 日本語 🧪 é  `, one Verify invocation, independent Proof/Result equality, screenshot, recorded temporary edit/restoration |

Browser help returned 12,480 bytes versus 27,601 in the earlier 18-call trial.
Native logged help returned 14,966 bytes including the duplicate; its previous
trial needed 16 logged help calls plus initial help. The new root help points to
one complete API reference, which explains handles, scopes, dialogs and recording.
These are individual fresh-agent trials, not a statistically established rate.

The browser agent recovered from one expected dialog interruption without retrying
Save. The native agent requested 15 fps from a fixed-30-fps driver; it received a
clear pre-dispatch refusal and used the default. It did not repeat Verify. Both
recordings decoded completely and were visually inspected. Browser output was
1920×728, 21.7 s, 217 encoded frames/34 source frames; native was 480×232,
20.57 s, 617 encoded frames/606 source frames. No sustained-fps claim follows.

A prior source-backed retest completed both tasks but the browser's post-close
inventory was refused when concurrent builds changed engine identity. That is
retained as a test-environment failure, not a clean acceptance run. Immutable
package acceptance above closes that test gap.

Both fresh agents noted that earlier output in an exec program is unavailable
when a later step throws. Existing unknown-outcome rules prevented replay, but
preserving bounded partial output would improve recovery/context efficiency.
This remains a separate Wayfinder item; it is not hidden by the passing jobs.

## Build, deployment and remaining parity

Candidate: `release/cli-modal-20260924/mac-arm64/Mako.app`.
Engine: `ca870ae32de6eda1a82cbb85a0445c76ebc53c7bfde9bc693350d47deffaf885`.
The package verifies 1,088 frozen build files and 677 host imports, signature,
ASAR CLI/worker/state/cleanup, public MCP absence, direct startup and
LaunchServices startup/reopen. Full build, CLI/service/modal/focus/extension
regressions and lint passed; lint retains five existing React/TanStack warnings.
The superseded generated `15ebe10a1502342e` candidate was removed after its
processes stopped; its historical evidence remains in the earlier review.

The idle updater verifies candidate/signing identity and the original installed
build, refuses competing host/build changes, never force-stops work, retains the
previous app, verifies the new shared-host build and runs installed ASAR CLI plus
scripted Aside/AppKit checks. Those scripts were proven against the candidate
before being queued. The receipt distinguishes waiting, installation, validation,
validated completion and failure. The signed candidate, receipt and evidence do
not imply every provider's installed launch path has passed a fresh-agent job.

Overall equal-or-better parity remains unproven. Proactive native focus protection,
physical IME/concurrent human typing, sustained 1080p capture, additional platform
coverage and broader matched reference jobs remain in Wayfinder. The previous
OpenAI reference timeout is a scoped counterexample, not proof of superiority.

Sanitized evidence is kept here; raw fixture traces/media are under
`/tmp/mako-modal-review`, `/tmp/mako-cli-retest-VUptml` and
`/tmp/mako-cli-package-ghdo6h`. They include browser inventories and are not
committed. Reusable regressions are `scripts/test-browser-modal.ts`,
`test-browser-focus.ts`, `test-browser-extension-router.mjs` and
`test-browser-extension-activity.mjs`; `test:control-cli` includes modal checks.

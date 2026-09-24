# CLI-only browser and computer use acceptance

September 24, 2026. Source and signed-candidate acceptance, not default installed-host acceptance.
[Wayfinder](local-control-map.md#lc-20--shared-engine-and-composable-cli)
owns release status. [Machine-readable results](local-control-cli-results.json)
contain the final engine identity and bounded measurements, without provider
credentials, raw transcripts or page contents.

## Contract delivered

Each desktop task owns a supervised Node session. Every provider launch path
receives its exact `mako-control` executable and private session descriptor.
Codex app-server, ACP, Claude SDK and Cursor SDK use the same environment helper;
the conversation owner supplies command-first instructions. The public Local
Control MCP adapter, managed registration, package export and executable are
removed. The patched Cua executable still uses its private protocol. Unrelated
Mako/provider MCP integrations remain.

Commands share targets, references, program state, uncertainty and recordings.
They do not launch a replacement engine per action. Text observations capture no
images. Screenshots and explicit script images become files, with pixel metadata
and artifact receipts. Programs can batch verified actions without a model round
trip between every operation. `--help` is offline and command-specific; `api`
provides focused runtime documentation. There are no public continuation cells.

The owner passes browser credentials over IPC, not in CLI arguments, shims or
provider control variables. Worker environments have an explicit allowlist.
Private directories/shims are 0700; socket/descriptor files are 0600. This protects
against other users, not mutually untrusted processes sharing a UID. Cloud jobs
still require their own container/VM boundary.

## Repeated correctness and lifecycle checks

`npm run test:control-cli` passed after the final edits. It builds the desktop
integration and checks:

- Separate CLI processes retain exact Unicode/whitespace and shared state.
- Scoped observations, strict selectors and stale screenshot coordinates retain
  the shared engine's accuracy checks. Misspelled inputs refuse before dispatch.
- Stdin, files with spaces, exclusive image output, explicit format and artifact
  spill compose without base64 image output on stdout.
- Lost replies/broken pipes preserve unknown outcomes. Cancellation never replays
  input. Partial program state and target recovery remain explicit.
- Recording finalization outlives a cancelled waiter. Repeated stop shuts down
  capture once; unrelated tab work and concurrent programs continue.
- Explicit stop, worker SIGKILL and parent SIGKILL remove owned launch files.
  A lost desktop worker also releases its browser ownership and task tabs.
- Inherited control credentials do not configure the worker. Closing the owner
  refuses late session starts.

The final fixture took 3,495 ms. Across 34 recorded commands, p50 was 100 ms and
p90 114 ms, including CLI process startup. These are local fixture measurements,
not a browser/backend benchmark, viewer latency measurement or a before/after
speedup claim. The desktop lifecycle setup/checks took 1,041 ms; five concurrent
offline help invocations took 103 ms wall time.

Managed MCP registry tests confirm Local Control is absent and unrelated servers
survive. Package checks passed public imports/types, relocation, exact code
identity, worker state, artifact spill, idempotent close, dependency boundaries,
secret canaries and absence of the removed public MCP entrypoint. Packed sizes
were 59,355 bytes for `@mako/control` and 129,639 bytes for
`@mako/control-runtime`; these exclude platform drivers, Chromium and encoders.
Full lint passed with zero errors, zero Oxlint warnings and five existing
React/TanStack warnings.

## Fresh agents and real targets

| Run | Independently checked outcome | Limit |
| --- | --- | --- |
| Codex browser CLI | Screenshot read, exact fixture values, one trusted form submission, verification and task-tab cleanup. | Source-host connection; not installed Aside acceptance. |
| Claude browser CLI | Same browser workflow with one correct trusted submission. | Does not establish native Claude coverage. |
| Cursor browser CLI repeat | Same workflow entirely through the task CLI, including files and retained script state. | Eight help calls, 9,494 UTF-8 output bytes; learning efficiency remains open. |
| Codex native AppKit CLI | Exact text and saved value independently read from the fixture; target never became foreground. | Other foreground apps changed during the run; not an unchanged-foreground or physical-typing proof. |
| Native Terminal CLI | High-level typing/Return with independently verified output; 67 unchanged foreground samples. | Scripted input, not physical IME/concurrent human typing. |
| Linux ARM64 Chromium CLI | Scoped edit, duplicate-button refusal, 65×37 element image, finished 780×494 video despite an interleaved clip, clean stop. | Short fixture, not sustained 1080p60. |
| Linux ARM64 GTK CLI | Exact Unicode, one Save, 640×420 and 320×210 images, JPEG, four concurrent programs, finished video and cleanup. | Unsupported pointer/60 fps requests were explicitly refused. |
| Linux lifecycle suite | All eleven isolated-job restart/crash/cancel/parent-loss and cleanup scenarios passed through the CLI. | This iteration used ARM64; native x64 must rerun the new package. |

Reproduce fresh runs with `node scripts/test-provider-e2e.mjs codex --control`
and `node scripts/test-provider-e2e.mjs claude cursor --browser-only` after the
build. These use disposable fixtures and real installed providers. The acceptance
runner copies built control packages into its private test directory so a dev
watcher cannot change the CLI's code identity midway. Third-party dependencies
remain linked from the declared installation; credentials/profiles are not copied.

Linux jobs are `scripts/test-control-cli-linux.mjs`,
`scripts/test-control-cli-native-linux.mjs` and
`scripts/test-cloud-control.mjs` in the reviewed runtime image. The
acceptance payload remains allowlisted. These tests do not need contributor
cloud credentials in the repository.

## Signed app candidate

`release/cli-migration-20260924/mac-arm64/Mako.app`, build
`15ebe10a1502342e`, passed signature verification, 1,086 frozen build-file checks,
677 host import checks, and both direct/LaunchServices startup tests. Full app size
is 662,882,436 bytes. The full build caught an unsupported TypeScript parameter
property in the supervisor; explicit field declarations fixed it before packaging.

`scripts/test-packaged-control-cli.mjs` passed against that actual app archive:
child worker startup, task shim, offline help, exact Unicode state across separate
shell processes, matching code identity, public MCP absence and shutdown cleanup.
The Mac packager now requires this check on future candidates.

The candidate then ran `scripts/test-installed-browser.mjs` against the installed
Aside extension and regular profile. All 40 jobs passed: scoped exact-value edits,
one Save per job, duplicate Save refusal, untouched Billing form, dialog handling,
recording and screenshot, interrupted-video retention, reconnect, and refusal of
old handles. The recording finished at 1920×728 for 16.97 seconds with 60 pointer
samples; it is not a sustained 1080p60 test. All 326 foreground samples stayed on
the initial app. This does not establish physical concurrent typing.

The readiness probe still found the installed app/shared host running. The app on
disk is `345bfd91c64009c6`, independently installed before this candidate; this work
did not replace it. Candidate acceptance must not be reported as acceptance of
that default shared host.

## Rejected runs and remaining gates

An initial native Electron fixture hit the existing `page-input-required` guard;
a development rebuild later invalidated its CLI. That run failed. The AppKit
repeat proves the native route, not a fix to Electron input admission.

An earlier Cursor run completed the form only after bypassing a build mismatch
with private socket requests. It is not CLI acceptance. The runner now rejects
that mismatch and uses a fixed runtime; the repeat passed without the workaround.
Build identity is a compatibility check, not protection against a same-user agent
that deliberately constructs private requests. Recovery text directs agents to
the matching CLI or task owner rather than a stop command that would also fail.

Installed rollout remains open: the readiness probe found the installed app and
shared host running, so neither was replaced. After a verified release is installed
at idle, rerun Aside and native workflows on that exact host/extension/driver.
Fresh ACP workflows, latest native x64 acceptance and help-efficiency improvement
remain separate evidence gaps. Physical IME/human typing, proactive focus
protection and compositor coverage are unchanged. Streaming work remains paused
until the CLI migration release gate closes.

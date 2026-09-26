# T3 parity audit

Checked September 8, 2026 against freshly fetched source. **Mako is not established as equal to or better than T3 across the product.** The earlier work proved several important workflows, but it left feature gaps and treated some unlike features as interchangeable. This audit corrects that assessment.

The [33-area matrix](MATRIX.md) distinguishes concrete gaps, partially supported areas, unverified behavior and a product-scope difference. Each row states what would close it. Its source links resolve against pinned commits. The [source evidence](source-evidence.json) records file hashes and line anchors, and reads capabilities from Mako's actual provider registry. Finding an API or passing a unit test is not scored as comparative parity.

## Fresh references

- T3 main: `7fbc545ae8c7866ac2b39648120cb2a17250d8b4`.
- Orchestrator V2: `91b193653ec82f40a2dd742a88237b1f7bdcc6f9`, PR 2829 still open and unmerged when checked.
- Main moved across 20 files from the prior SDK review, including composer stability, context accounting, Git controls and setup flows. V2 moved across two timeline files. The provider findings were rechecked at the new revisions.

This is a source and existing-evidence audit with additional local renderer/draft regressions. T3 was not installed or executed, paid provider tests were not repeated, and no matched latency or quality benchmark was run. Uninspected platform and native-computer behavior stays unverified. Earlier Orca iframe findings are not attributed to T3.

## Concrete findings

These findings describe the audit baseline. Subsequent [implementation and verification](../parity-implementation/README.md) added native-agent observations and a proposed-plan workflow. Their remaining limitations are recorded there; the original matrix is not a claim about the completed implementation or a comparative test result.

1. **The new Tasks dialog is not T3's Agents panel.** It displays Mako-delegated conversations. T3's panel projects provider-native subagents with identity, lifecycle, activity, model/token readings and workflow groups. Mako's transcript recognition of agent tools does not close that gap.
2. **Plan tooling is incomplete at the product level.** Mako retains plan entries, while T3 has a proposed-plan workflow with compact presentation, copy/export/save and follow-up state. Rendering a plan tool is not equivalent.
3. **Cursor has an unresolved capability tradeoff.** Mako's registered ACP driver has `canResume: false`, no steering and no manual compaction. V2's SDK adapter supports create/resume and `/compress`, but explicitly rejects steering and exposes no interactive approval callbacks. An SDK migration must not silently discard approval behavior.
4. **Claude's exact native fork-at-turn is missing.** V2 calls its SDK fork operation. Mako's SDK driver does not advertise it. Portable historical forks and filesystem rewind are useful but provide a different guarantee.
5. **Codex manual compaction is not usable safely in Mako yet.** The previous real test reached accepted/completed but lost earlier context after native resume. The capability remains withheld. This is a known failed workflow, not a completed parity item.
6. **Git hosting coverage differs.** T3 has GitHub, GitLab, Bitbucket and Azure DevOps source-control implementations. The inspected Mako PR integration is GitHub-specific.
7. **The integrated browser product differs.** T3 has device-toolbar, recording, import and annotation paths. Mako's browser control transport and preview do not establish equivalent user workflows. High-level automation and frame coverage also need matched tests.
8. **Retention, onboarding and packaged behavior are unfinished.** Individual snapshot limits do not bound total storage. Fresh-user setup and packaged SDK/native permission paths have not been verified end to end.
9. **A literal all-features claim conflicts with Mako's current product contract.** T3 exposes worktree provisioning/management. Mako's AGENTS.md explicitly excludes a worktree manager. Internal isolated task workspaces do not make that user-facing feature equivalent. This audit does not change that contract.

## What the evidence does support

The [SDK report](../sdk-controls/README.md) and retained real-provider results support Claude steering, compaction, same-native-session resume and marker recall; Codex steering, same-native-session resume and recall without compaction; and actual filesystem rewind for both. Focused tests cover duplicate IDs, stale turns, uncertain delivery, journal recovery and workspace restore compensation.

The [browser evidence](../../2026-09-07/browser-extension-evidence.json) contains a successful controlled extension workflow for each of the six Mako providers. It does not establish a statistical success rate or universal browser parity. OpenCode v1 failures remain explicit.

Mako's restore design preserves staged/unstaged state and retains the original conversation. These are useful strengths supported by its own tests. Calling them a comparative advantage still requires executing the same crash, staging and external-edit cases against T3.

## Closure order and acceptance

| Priority | Work | Acceptance evidence |
| --- | --- | --- |
| 0 | Memory incident and bounded verification | Attribute process-tree physical footprint, distinguish app grouping from individual daemons, and run a bounded soak without continuing after pressure or growth. No broad stability claim until explained. |
| 0 | Finish conversation UX | Real idle/working/approval/failure states, narrow and wide layouts, nested popovers, Escape/focus restoration, preserved drafts and no layout shift. Save before/after captures. |
| 0 | Packaged lifecycle | Isolated package launches the SDK executable, resumes history, survives Stop/restart, and handles denied native permissions. Do not replace the installed app merely to run this test. |
| 1 | Native agent monitor and plan workflow | Provider-owned events project into shared state; registered companion shows native children and task results; plan revision/export/continuation works. |
| 1 | Native capability gaps | Claude fork at the exact run; Cursor native resume/compaction with explicit approval policy; Codex compaction with verified retained context. |
| 1 | Checkpoint growth and latency | Retention preserves active/recovery references. Cold/warm capture and restore latency measured on small/large repositories; disk growth bounded. |
| 2 | Browser/computer workflows | Identical nested-frame, trusted-input, screenshot, dialogs, downloads, clipboard and reconnect scenarios on both systems and supported transports. |
| 2 | Git hosting and onboarding | Fresh install/login/expired credential and PR/review workflows on every advertised host. |
| 2 | Remote, scheduling and platform coverage | Sleep/wake, missed jobs, reconnect, lease loss, updates and supported-OS tests. |
| Final comparison | Matched agent tasks | Same model version, effort, budget, repository, prompts and tool access. Measure correctness, regressions, retries, tokens, latency and user interventions across repeated runs. |

This ordering is an implementation and verification backlog, not a claim that these items were completed during the audit. Other rows in the matrix remain explicit until their acceptance evidence exists. A percentage-complete score would hide the difference between an untested workflow and a demonstrated failure.

## Reproduce this audit without starting agents

```sh
node --max-old-space-size=256 scripts/audit-t3-parity.mjs /path/to/t3-main /path/to/t3-v2
npm run test:live-controls
```

The first command validates 94 references in 89 distinct files, refuses unexpected reference revisions, regenerates the matrix/evidence and reads the six registered Mako providers. It does not fetch source, scan native sessions or start agents. A successful exit means evidence references are valid, not that parity passed.

The renderer check bundles the actual UI components into a small Node test. It verifies that completed receipts are available on demand, pending and uncertain receipts stay visible with saved input, and a closed Tasks dialog does not put a form in the transcript. Draft tests verify late acceptance cannot erase newer text or another conversation's draft. These checks do not substitute for browser, focus or visual validation.

The stale no-steering paragraph in the [snapshot report](../snapshots-controls/README.md) now points to the implemented SDK controls and this matrix.

## Checks completed in this audit

The source-evidence generator passed and was rerun after formatting. `npm run test:live-controls` passed against the actual rendered components and persistent draft store. The new test files were separately typechecked successfully. The full application `tsc -b` check exceeded the deliberate 512 MB Node heap cap and exited with allocation failure; it is incomplete, not a pass. The cap was not raised and the full check was not retried. The earlier unrestricted build predates the latest draft-store edits. `git diff --check` passed.

`npm run lint` passed with zero errors; Oxlint reported zero warnings and errors. ESLint retained the two existing React Compiler warnings for isolated TanStack virtualizers. See [lint output](../../../audits/2026-09-08/t3-parity/lint.log). Checks were sequential, with a 512 MB Node heap limit for lint/type checks and 256 MB for the registry/render test. These are heap limits, not physical-footprint or system-memory guarantees. No additional provider run, browser host or desktop package was started.

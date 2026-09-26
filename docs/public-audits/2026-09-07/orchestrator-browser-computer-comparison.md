# Mako provider, browser and computer assessment

Updated September 8, 2026 after the control rebuild, provider UI investigation and extension transport verification. Mako now owns its browser connection and exposes exact task bindings through MCP. The removed Python daemon is described only in the [historical permission audit](browser-permission-subsystem-audit.md).

The work establishes specific functioning workflows and fault behavior. It does not establish that Mako is better than Codex overall, that all providers expose identical native controls, or that every possible UI interaction has been tested.

## All six providers

Every registered live driver passed the shared lifecycle checks for open, running, completed, closed while awaiting permission, and later external activity. An open process, a recently changed transcript, and a running turn are separate states. Only explicit running or permission evidence puts a session in Running now.

| Provider | Live work started in Mako | External activity evidence | Store and model evidence |
|---|---|---|---|
| Claude Code | ACP lifecycle and permission events | Registry state plus live process identity; idle/unknown is Open. Failed process verification is unavailable. | Native translation/follow tests; real file-tool/model round trip passed |
| Codex | App-server lifecycle and permission events | Open rollout plus bounded task-start/completion parsing. Completion clears Active even when the file stays open. | Gigabyte rollout, resumed-path selection, native restart/fork, translation/follow, real model tests passed |
| Cursor | ACP lifecycle and permission events | An open native database establishes Open, not a running turn. | Native database/WAL and follow tests; real file-tool/model round trip passed |
| Grok | ACP lifecycle and permission events | Registry plus verified process identity establishes Open. Failed identity reads are unavailable. | Streaming/follow tests; real file-tool/model round trip passed |
| Devin | ACP lifecycle and permission events | A session lock establishes Open. It is not sufficient running-turn evidence. | Streamed rows, tools, reasoning, locks and follow tests; real file-tool/model round trip passed |
| OpenCode | ACP lifecycle and permission events | V2 checks registered local service health, PID/version identity and active session IDs. V1 supports explicit busy/retry/idle and permission events through the activity plugin. External processes without those signals remain unknown; persisted rows and recent timestamps do not claim Active. | V1/V2 stores, tools, interruption, compaction and follow tests; real file-tool/model round trip passed |

The paid six-provider evidence is in [paid-provider-evidence.json](paid-provider-evidence.json). It is separate from the new shared lifecycle fixtures. Separate browser-model workflows now pass for all six providers over the extension transport, as recorded below. OpenCode v1 has distinct model and authentication failures; the successful OpenCode browser result uses v2.

Additional fixes from the live UI investigation:

- Codex discovery resolves resumed rollout aliases through the provider's canonical SQLite path and physical file metadata. Historical explicit paths remain readable.
- Loading and failed thread opens retain the exact provider and draft owner. Superseded responses cannot replace a later selection. A successful retry follows once; a missing cached page becomes a readable failure instead of permanent loading.
- Host loss shows a persistent notice and Last known activity. Sending is disabled before drafts or attachments are cleared. The workbench remains mounted.
- Terminal loading exposed shared Vite cache corruption: the gateway regression server invalidated the running desk's optimized xterm files, returning HTTP 504. Development servers and tests now own separate caches. A new regression checks the four exact dependency URLs before and after the gateway test. Panel error boundaries also keep a failed companion from unmounting the conversation. The real terminal then loaded and printed `MAKO_TERMINAL_CACHE_OK` through actual keyboard input.
- Settings switches require accessible labels in the shared component. File browsing distinguishes loading, empty results, and failed reads with Retry.

## Current control architecture

`BrowserService` owns one WebSocket per discovered browser profile. Multiple MCP clients join the same pending connection and use the same connected transport. Closing a client does not close Chrome. Browser restart or host shutdown invalidates the generation. Each target handle carries browser, tab, generation, and a lease; ownership is tied to the Mako conversation and checked at dispatch.

Browser tools never pick a replacement tab or replay a failed action. A timed-out or cancelled dispatched mutation can have an unknown result. That binding refuses more mutations until observation. Takeover is explicit and cannot steal an active operation. The service uses page focus emulation for background input and disables it on release.

The MCP contract supplies typed tools and server instructions for discovery, connection, target ownership, navigation, accessibility observation, screenshots, input, file uploads, events, JavaScript, and raw CDP. `mako_browser_help` exposes the installed protocol schemas. The extension CDP route supports Chrome’s permitted debugger domains, including network inspection/interception, emulation, keyboard and pointer input, and page dialogs. Browser-wide download configuration and SystemInfo require the optional direct-CDP transport. Raw target lifecycle mutations are constrained so ownership stays with Mako. `concurrent:true` lets a caller answer a paused network request or dialog while another command waits.

`mako_browser_exec` runs asynchronous JavaScript in a terminable worker, with persistent per-client state, text output and native image output. Awaited operations use the same host service. Run identity prevents late messages from leaking into another script; unawaited work and CPU-bound cancellation are tested. This is trusted local JavaScript with operating-system power, not a sandbox.

The computer MCP forwards the native CUA driver's schemas, annotations, image blocks and structured coordinate metadata. Mako injects the task session identity so the caller cannot replace it. Failed initialization closes the failed transport; a later request creates a fresh SDK client. Mutating calls are not replayed. Native driver capabilities include window/app discovery, accessibility and pixel targeting, keyboard, pointer, scroll/drag, menus, clipboard, dialogs and window operations. Mako uses its embedded driver socket. The legacy macOS wrapper remains an availability fallback, not a second browser transport.

Chrome connection approval, macOS Accessibility/Screen Recording, and provider tool approval are separate. The default transport is now a Manifest V3 browser extension with native messaging and profile-scoped registration. Its installation grants debugger access; ordinary connections do not use the remote-debugging approval dialog. Chrome can still show its debugger information banner, and revoking or removing the extension revokes access. Direct CDP is retained only for explicitly configured endpoints. Connected extension profiles appear independently in discovery.

## Verification after the rebuild

| Check | Result and limit |
|---|---|
| Browser service fault suite | Ten task clients share one connection; serialized claims, stale leases, restart generations, closed targets, cancellation uncertainty and binding authorization pass with a protocol fixture |
| Script runtime | Persistent state, native images, CPU cancellation, cancelled queued work, late/unawaited work and recovery pass |
| Real Chrome | Two exact targets, real images and coordinates, trusted input, one independently recorded submission, replacement-client binding recovery and closed-target refusal pass |
| Real Mako through its own browser MCP | Opens the actual web desk and selects the active audit conversation using observed controls |
| Real model browser workflow | Claude, Codex, Cursor, Devin, Grok and OpenCode v2 each read a random page value, inspect four red/two blue squares, fill three fields with trusted input and submit once. Server readback validates values and trusted event flags. The prompt names the tool family, so this is not a tool-discovery benchmark from an uncoached user prompt |
| Computer proxy fault suite | First backend initialization fails; second succeeds on the same outer MCP connection. Native schema, task identity, annotations, images and metadata pass |
| Real computer control | Disposable Electron window, exact PID/window/token, screenshot, field entry, button activation, independent renderer readback and stale-token rejection pass |
| Real UI | Agents, MCP, Skills, Integrations, Editor, Conversation, Appearance, Keyboard shortcuts, Commit messages, Automations, UI extensions, Updates, Crash reports and About inspected. File filter and actual conversation selection exercised. Long palette queries, dismissal, the terminal dock and real terminal input/output were also checked. Account/configuration writes were not needed |
| Earlier rebuild checks | Session package, live/conversation control, provider, stage/thread-opening, host, web, MCP, typecheck and production build passed before the later concurrent settings migration. Oxlint reported zero warnings/errors; ESLint had two existing TanStack Virtual compiler warnings. The current verification status is recorded at the end of this report |

Earlier direct-CDP browser evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-browser-e2e-gAQhgf`.

Latest real computer evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-control-e2e-f3JCJZ`.

Earlier Claude/Codex browser evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-provider-e2e-kC1tY6`.

The computer fixture used the development host and installed CUA driver. It does not certify OS permission attribution for a separately signed or packaged release. The desktop and web app share renderer and host contracts; the real web/preload tests verify both boundaries, but this is not a full packaged-release test.

The live cache regression can be rerun while the web desk is running:

```sh
node scripts/test-web-cache.mjs http://127.0.0.1:5174/
```

The normal web test owns its temporary cache and does not depend on a running desk. The manual browser observation also reproduced the cached import error inside the terminal boundary while the composer and rail remained mounted.

## Comparison with the available Codex tools

The installed browser API was inspected, including Playwright locators, frame locators, file chooser support, clipboard, dialogs, event waits, console logs and browser capabilities. This is an API comparison, not a matched reliability benchmark.

| Capability | Mako | Available Codex browser/computer tools |
|---|---|---|
| Existing browser control | Browser extension and native messaging with exact owned targets; explicit direct-CDP configuration also supported | Browser extension or built-in browser; explicit tab claiming |
| Flexible browser programming | Persistent JavaScript plus extension-permitted CDP; direct CDP is optional | Persistent JavaScript orchestration with Playwright, browser CUA and optional CDP |
| Common browser actions | Typed click/type/upload; other actions through CDP and protocol help | Rich locator fill/press/check/select, waits, frame locators and CUA helpers |
| Screenshots | Native images with target identity and coordinate metadata | Native screenshot/image output |
| Native applications | Full installed CUA MCP tools and task session injection | Native app/desktop CUA API and persistent orchestration |
| Integrated browsing product | No separate managed browsing profile, page annotation UI or content-export product | Built-in profile/preview, page annotations, content exports and site controls |
| Permission product | Chrome connection state plus OS permissions; trusted local execution | App and site controls integrated into the desktop product |

The [official browser documentation](https://learn.chatgpt.com/docs/browser) describes preview, annotations, existing-browser access and site controls. The [official computer-use documentation](https://learn.chatgpt.com/docs/computer-use) describes platform-specific app controls. Mako does not match that entire product scope. Raw CDP gives broad control, but it is not equivalent to already having all the higher-level helpers or integrated UX.

Remaining work is concrete: richer ergonomic browser helpers, a persistent native-computer scripting API, packaged-release permission tests, broader native app coverage and same-model/same-budget comparative workflows. An already open historical rollout also does not automatically switch to a new canonical path while preserving every draft and attachment; reopening uses current discovery. These limits should remain explicit.

## Orchestrator v2

The comparison remains pinned to PR #2829 revision `415ed0f73b97f1655b6282492f81d0b2bba3a9cc`, covered by the [source investigation](../2026-09-06/orchestrator-v2-deep-dive.md). The expanded proposal-status evidence below records the later status check; the implementation comparison remains pinned to the reviewed revision.

Mako has durable conversation identity, provider switches, receipts, scoped child delegation, portable context and attachment transfer, and tested native Codex restart/fork paths. Those are covered in [conversation-control.md](conversation-control.md). Coordinated filesystem/provider/history rewind, richer native steering/snapshot controls, and a fully normalized graph of provider-native background work remain differences from the reviewed v2. The rebuilt browser transport does not establish parity in those areas.


## Appshot and preview follow-up

The [accessibility and capture review](capture-performance-and-accessibility.md) records the current design, maintained open-source references with stars and commit dates, lifecycle fixes, real UI evidence and remaining performance limits. The preview is scoped to its conversation pane. Appshots attach one visible image with accompanying window text and remain in the owning draft. Continuous native preview is supported in the desktop app; the web desk retains the latest native observation.

Account routing now rejects missing or invalid selected credentials instead of silently falling back. Capture uses exclusive private directories, respects custom Codex and Claude configuration homes, and preserves existing saved accounts. Account selection persists per provider. This does not add an OAuth wizard or live account switching to every provider: Claude and Codex have selectable saved accounts, OpenCode observes its native accounts, and the other providers use their CLI-owned authentication. OpenCode v2 completed the live file-tool fixture; the installed v1 could not complete the follow-up run due to authentication/database errors. These limits remain distinct from the shared browser/computer tools available to provider processes.


## Expanded source comparison, September 8

The [reference inventory](reference-inventory.json) records complete branch, open-PR and open-issue metadata inventories for Orca, T3 Code, MonoCode, Omnigent, OpenCode and both requested Codex rebuild repositories. This is an inventory, not a claim that every branch was built or every issue reproduced. Relevant implementation paths and selected proposals were inspected separately. [Proposal status evidence](parity-proposals.json) records eight still-open PRs with their exact revisions and check times. `scripts/audit-parity-proposals.mjs` repeats that status check.

| Reference | Checked implementation | Implication for Mako |
|---|---|---|
| Orca | [Restart authentication preservation](https://github.com/stablyai/orca/blob/b6d5972ec4539a96be5a70bfc611517e780e7c3d/src/main/agent-auth-restart-preservation.ts) synchronizes Claude and Codex runtime authentication before restart within a lifecycle budget. Its managed account homes have substantially more lifecycle machinery than copying a login once. | Mako isolates selected account environments, rejects missing identities and preserves existing captures. Existing sessions retain their account binding. Automatic account migration on restart and refresh-token reconciliation need their own proofs; account discovery alone does not establish parity. |
| MonoCode | [Codex discovery](https://github.com/hardbeat920/monocode/blob/568f246cfc200dcb57377dfad8fe2c5700b07465/src/lib/harness/codexCatalog.ts) checks `account/read` and gives native CLI login instructions. [Grok authentication](https://github.com/hardbeat920/monocode/blob/568f246cfc200dcb57377dfad8fe2c5700b07465/src/lib/harness/grokProtocol.ts) chooses advertised API-key or cached-token methods. [Tool preview](https://github.com/hardbeat920/monocode/blob/568f246cfc200dcb57377dfad8fe2c5700b07465/src/lib/harness/preview.ts) limits text to six lines of 120 characters. | Native authentication readiness and compact tool summaries are useful patterns. Text previews do not constitute a live browser or computer feed. Mako must expose provider-owned account capabilities rather than promise switchable accounts for every CLI. |
| T3 Code | [Preview automation broker](https://github.com/pingdotgg/t3code/blob/cd096b9ad5a4156ffeab85de617cbb219057007f/apps/server/src/mcp/PreviewAutomationBroker.ts) pins provider-session ownership to the exact desktop connection and queue. Replaced or disconnected connections invalidate that assignment. | Mako similarly checks task, binding, target generation and lease at dispatch. Its preview subscriptions stop polling while hidden or inactive. Authentication expiry and live target ownership are distinct lifetimes. |
| Omnigent | [OpenCode onboarding](https://github.com/omnigent-ai/omnigent/blob/3b653b922dc0a50f432a00e8f9b2cfcd76c53fc5/omnigent/onboarding/opencode_auth.py) respects XDG data paths and leaves credentials with OpenCode. [Cursor onboarding](https://github.com/omnigent-ai/omnigent/blob/3b653b922dc0a50f432a00e8f9b2cfcd76c53fc5/omnigent/onboarding/cursor_auth.py) uses API-key storage for its own runtime. | Mako now respects the configured OpenCode data directory. Omnigent's Cursor API-key route and Mako's native Cursor CLI login are different integrations; copying one would not establish account-switching parity for the other. |
| Haleclipse rebuild | [Pinned repository](https://github.com/Haleclipse/CodexDesktop-Rebuild/tree/369e442c97efcb901535dab1d1922b2001946e7d) contains repackaging and patch scripts. Its README describes extracted Electron and webview assets; those source directories are absent from this checkout. | This checkout is evidence about packaging, not an independently maintained implementation of Codex's computer-use UX. The installed application was inspected separately. |
| Linux Codex rebuild | [Accessibility reader](https://github.com/ilysenko/codex-desktop-linux/blob/758b4ce74301c387c6006698921384d4ca1dc47d/computer-use-linux/src/atspi_tree.rs) bounds node count, depth and text readback. Its [entry point](https://github.com/ilysenko/codex-desktop-linux/blob/758b4ce74301c387c6006698921384d4ca1dc47d/computer-use-linux/src/main.rs) exposes accessibility state and screenshots separately. Window targeting has compositor-specific backends. | Accessibility should drive semantic targeting. Pixels remain necessary for canvas, visual layout and image-only content. Background input support must be established for each native backend; Linux support is not proof of macOS behavior. |

Selected open proposals are relevant but are not shipped behavior:

- [Orca #14877](https://github.com/stablyai/orca/pull/14877) carries account-switch intent across restart and moves a resumable Codex conversation to the selected account.
- [T3 #10501](https://github.com/pingdotgg/t3code/pull/10501) expands agent-usable preview and saving; [#10401](https://github.com/pingdotgg/t3code/pull/10401) makes OpenCode preview registration best effort; [#10141](https://github.com/pingdotgg/t3code/pull/10141), [#9505](https://github.com/pingdotgg/t3code/pull/9505) and [#7302](https://github.com/pingdotgg/t3code/pull/7302) concern preserving useful detail while bounding preview and snapshot payloads.
- [Omnigent #4647](https://github.com/omnigent-ai/omnigent/pull/4647) proposes a native computer-activity panel. [#5854](https://github.com/omnigent-ai/omnigent/pull/5854) fixes expired account credentials falling through to an unrelated authentication mechanism.

Reported regressions also define useful acceptance cases: [Orca #18355](https://github.com/stablyai/orca/issues/18355) asks about background operation, [#17942](https://github.com/stablyai/orca/issues/17942) reports duplicated native text input, and [#17261](https://github.com/stablyai/orca/issues/17261) reports stale account attribution after switching elsewhere. T3 reports [preview detachment after leaving a thread](https://github.com/pingdotgg/t3code/issues/6355), [blank failed previews](https://github.com/pingdotgg/t3code/issues/7212) and [screenshot timeout loss](https://github.com/pingdotgg/t3code/issues/10366). These are issue reports, not independently reproduced findings about those products.

### Installed Codex and appshots

The installed Codex application was inspected read-only at version `26.901.51231`. The inspected package fingerprint was `46cbd30baec3e87e61e2110d1db125606eb24278d1677e03f3b2c7208c58372a`. The bundled host has a managed computer-use service with serialized lifecycle operations and separate appshot/computer-use enablement. Its command registry includes appshot capture. Feature flags and minified names alone do not prove frame rate, latency or availability for every account.

[Official Appshots documentation](https://learn.chatgpt.com/docs/appshots) describes a foreground-window image together with available accessibility text, attached to a conversation. That is distinct from a live observation feed. Mako now has explicit app/window capture with target identity and a task-bound control preview. Its desktop native-window preview uses Electron's video source; the web desk uses the agent's last native screenshot. A continuously refreshed native web preview is not implemented.

[Official computer-use documentation](https://learn.chatgpt.com/docs/computer-use) describes macOS background operation. Mako's browser input avoids moving the physical pointer. Native app operations depend on the driver's support for that operation and app; no universal zero-focus-interruption claim is justified. See the [capture performance and accessibility assessment](capture-performance-and-accessibility.md) for the implemented capture budgets and measured limits.

### Account UI and routing changes from this comparison

Account settings now consume provider-owned labels, login commands and selectable/observed capability metadata from one host catalog. Empty providers still show how to add a login. OpenCode credentials use the same metadata-driven rendering path and remain managed by OpenCode. Installed provider status no longer labels a mere executable as authenticated and ready. A dedicated account refresh action reloads identities and usage.

Claude and Codex discovery and usage reads now follow their configured homes, consistently with process launch and capture. OpenCode discovery follows `XDG_DATA_HOME`. Isolated routing tests cover those directories, invalid credentials, missing selections, traversal rejection and preservation of existing captures. This does not yet provide native OAuth onboarding inside Mako for every CLI, automatic refresh-token reconciliation, or account migration for an already-running task.


## Extension restart verification

The packaged extension ran in an isolated Chrome for Testing 151 profile through real native messaging. Two successive browser launches retained the same extension profile ID and rotated the native bridge secret. Both launches opened a background tab, navigated to a local fixture, clicked and typed with trusted events, rejected a second client trying to attach to the owned tab, captured a decoded JPEG screenshot, and closed the tab. Browser shutdown removed its registration. Evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-extension-e2e-3wJAVK`.

`npm run test:browser-extension` verifies framing limits, private filesystem permissions, rejection of web origins and incorrect secrets, per-client response routing, duplicate response suppression, and connection cleanup. `MAKO_TEST_CHROME=/path/to/chrome npm run test:browser-extension-e2e` repeats the real browser restart test. It uses a disposable profile and its own native-host registration. This proves the development package in Chrome for Testing; it does not prove a signed release or installation in every supported browser.

The extension package was prepared for the user's existing Chrome profile. Automated installation was blocked by the browser tool's extension-page security policy, so installation in that profile remains a manual step. No workaround was attempted.

The expanded provider browser fixture also passed with Cursor. Grok initially failed to interpret the screenshot; its later extension run passed. Devin's initial MCP router failure was fixed with provider-owned, process-specific configuration; an initial OpenCode v2 retry timed out during ACP startup. Both Grok and OpenCode v2 subsequently passed the full extension browser fixture. The initial failures remain part of the evidence and are not an estimate of a failure rate.


Devin's installed 3000.6.14 CLI advertised ACP session MCP servers in model context but routed calls only through file configuration. Its provider now supplies runtime additions through an isolated XDG configuration directory while preserving native settings and existing MCP definitions. Native settings remain linked to the provider-owned directory; scoped MCP credentials are private files and are deleted when the provider process closes. The full real-model browser fixture passed through the extension after this change, with correct random proof, four red/two blue squares, all three trusted input events and one trusted submit. Evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-provider-e2e-CUzB8N`. A regression test proves concurrent launches have independent credentials and cleanup.

Saved Claude account capture now reports Keychain write failures using a redacted error, and account removal deletes the scoped Keychain entry before removing its files. Failed removal retains the files for retry. The CLI-owned default login remains outside saved-account removal.


Grok and OpenCode v2 both passed the extension browser fixture with all values and trusted event flags verified by the local form server. Evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-provider-e2e-N993O8`. The normal installation resolver selected `/Users/kashyab/.opencode/bin/opencode2`. The isolated Chrome restart test passed again after those provider runs. This is a successful controlled workflow for each provider, not a matched statistical reliability benchmark.


OpenCode v1 1.18.21 was checked separately using `OPENCODE_BIN_PATH=/Users/kashyab/.opencode/bin/opencode`. Its default Big Pickle model read the correct form values but supplied JSON-encoded strings for the click argument and then submitted through a synthetic DOM click before correcting itself. The exactly-once trusted-input test failed, as intended. Evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-provider-e2e-q6sFX3`. A follow-up selecting its advertised `openai/gpt-5.5` failed before browser work with an invalidated native OAuth token. Evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-provider-e2e-jh6eOM`. V1 therefore remains unverified for this workflow; its native OpenAI login needs renewal before that model can be retested.

Browser MCP now distinguishes input rejection before dispatch from uncertain results after dispatch. Invalid tool arguments report `not-dispatched`; they do not imply that a browser action may have happened. Regression coverage verifies no browser calls occur for malformed click arguments. Tool descriptions distinguish trusted input from DOM-generated events and describe the extension connection flow.


Claude, Codex and Cursor were then rerun through the extension, and all three passed the same form, image and trusted-input checks. Evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-provider-e2e-u5xmn7`. Together with the Devin, Grok and OpenCode v2 runs, all six providers have a successful real-model run over the new extension transport.

The extension uses Chrome's [documented debugger domains](https://developer.chrome.com/docs/extensions/reference/api/debugger#restricted-domains). Browser and SystemInfo commands are unavailable through that API and now return an explicit error. Tool descriptions no longer claim those browser-wide commands or download configuration work through the extension. This transport change does not establish full raw-CDP or Codex browser feature parity.


## Verification status of the shared workspace

The September 8 work recorded successful Electron compilation, TypeScript checking, web gateway/preload tests, and the complete MCP/browser/computer/preview suite. The extension framing/router checks, real browser restarts, saved-account routing/Keychain checks and Devin configuration isolation checks also passed independently.

The final sequential verification passed together: `npm run typecheck`, `npm run test:browser-extension`, `npm run test:web`, `npm run test:acp-registry`, `npm run test:accounts`, and `npm run lint`. Oxlint reports zero warnings/errors. ESLint retains only the two existing TanStack Virtual compiler warnings. No rule was disabled or downgraded. Intermediate failures during the concurrent settings migration were resolved before this final run; the stale OpenCode account test now checks that the catalog does not invent a default model.

Installation in the user's existing Chrome profile is still pending the manual Load unpacked step. The running web host also rejected a second host instance, so the new setup panel has not been rechecked against a freshly restarted real host. No existing host was terminated to force that check.


The compact [extension provider evidence](browser-extension-evidence.json) preserves all six successful provider results and both explicit OpenCode v1 failures in the repository, including observed model IDs and server-side form submissions. It contains only disposable fixture data. The native restart tests are independently rerunnable through the extension test commands above.
# Follow-up: transcript presentation

The [September 8 transcript presentation audit](../2026-09-08/transcript-presentation/README.md) found that successful browser execution did not guarantee faithful history rendering. It fixes retained screenshots lost by the Cursor and OpenCode 2 readers, reproduces shared media/directive rendering gaps, and distinguishes direct UI comparisons from blocked or source-only checks.

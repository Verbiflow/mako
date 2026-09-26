# Accessibility and preview capture

Updated September 7, 2026, PDT. Repository metadata was fetched at 01:44 UTC on September 8. [Machine-readable inventory](capture-projects.json) records exact commit IDs and retrieval times. Rerun `node scripts/audit-capture-projects.mjs` for a small metadata-only refresh.

## Decision

Use accessibility for structured app text, controls and grounded actions. Use pixels for the visual preview. An AX tree does not contain an application's rendered image, and it cannot reconstruct custom canvas content or video. Mako already gets accessibility text for Appshots; it does not run OCR for this feature.

The [official Appshots documentation](https://learn.chatgpt.com/docs/appshots) describes a screenshot together with available accessibility text. It assigns image capture to Screen Recording permission and text access to Accessibility permission. This supports a hybrid design. It does not establish the private implementation or performance of Codex's live preview.

[Screenpipe's performance announcement](https://screenpipe.com/blog/screenpipe-v2-03-accessibility-capture) compares AX text extraction with OCR. Its advertised 100x figure is not a comparison with displaying a small native video stream and is not a benchmark of Mako.

## Maintained references

Stars are discovery signals, not a correctness or performance guarantee. Commit dates below are UTC.

| Project | Stars | Latest commit | Use in this review |
| --- | ---: | --- | --- |
| [CUA](https://github.com/trycua/cua) | 22,316 | September 8, 2026 | Existing native driver; exact window ownership and accessibility reference behavior |
| [Screenpipe](https://github.com/screenpipe/screenpipe) | 21,475 | September 8, 2026 | Event-driven observation, AX instead of OCR, pixel/text identity and bounded work |
| [Peekaboo](https://github.com/openclaw/Peekaboo) | 5,125 | September 7, 2026 | Capture lifetime, exact-window receipts and short-lived capture-plan caching |
| [AXorcist](https://github.com/openclaw/AXorcist) | 323 | September 4, 2026 | Focused macOS accessibility queries and actions |
| [Terminator](https://github.com/mediar-ai/terminator) | 1,632 | June 2, 2026 | Additional accessibility reference; less recently updated |
| [mac-cua](https://github.com/hyprcat/mac-cua) | 26 | April 20, 2026 | Small AX/ScreenCaptureKit example; not selected as the principal reference |

Screenpipe's [paired capture implementation](https://github.com/screenpipe/screenpipe/blob/1494836d8f34d2a388ae3393ac0e2d802b1c9d7a/crates/screenpipe-capture/src/paired_capture.rs) accepts an existing accessibility snapshot and a screenshot separately. It rejects attaching focused-window metadata to unrelated monitor pixels, checks whether text and pixels have coherent ownership, skips OCR when AX text suffices, and shares an OCR work permit across producers. These are useful boundaries; its continuous recording/indexing workload should not be copied into a chat preview.

Peekaboo's [window-plan cache](https://github.com/openclaw/Peekaboo/blob/471841fe930c554407482770cbf5a30d0bd8c089/Core/PeekabooAutomationKit/Sources/PeekabooAutomationKit/Services/Capture/ScreenCaptureKitWindowPlanCache.swift) caches capture configuration, not pixels, with a two-second lifetime and capacity 32. Callers still revalidate exact window identity and display topology. Mako similarly must never make a cached window name an authorization receipt.

Apple documents a bounded [ScreenCaptureKit frame queue](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/queuedepth) and a minimum frame interval. More buffering consumes more memory. Mako uses Electron's native window media source for the desktop preview, rather than adding an independent native recording service.

## Bugs found and changes made

- The system-wide preview window was removed. The overlay is a registered slot inside the owning conversation timeline, with no portal or extra BrowserWindow.
- Preview state is keyed by conversation. The inspector and overlay share one polling subscription for the same conversation. Removing one consumer cannot clear another task's frame.
- A chat with no control activity does not start polling. A settled action releases its native video after five seconds; the last screenshot can remain visible. Polling then stops and a new activity event wakes it.
- Hidden documents and hidden conversation panes release capture. Dismissal releases capture and retained renderer frames. Revoked task bindings clear the host preview.
- Native video requests at most 640 by 480 pixels and two frames per second. Failed playback stops its tracks.
- Browser previews request a small image at capture time, accounting for display density. Full-resolution agent screenshots keep their existing path. Captures do not overlap for the same task, and frames are retained under a fixed byte limit.
- A proposed web fallback repeatedly enumerated all Electron window capture sources. It was removed before restarting the host with it. The web desk currently uses the agent's latest native screenshot; continuous native video is desktop-only.

An automatic `get_window_state` call between an agent observation and action reproduced `STALE_ELEMENT_TOKEN`: the installed driver's AX snapshot replaces its per-window reference cache, even through another MCP client. Therefore the UI preview must not refresh that cache. This is an implementation constraint of the current driver, not a reason to reject accessibility APIs. A separately owned, read-only AX observer could avoid the conflict, but it would need its own tested lifetime and cache contract. Manual Appshot capture still requests image and AX text and can refresh that driver's window references.

## Laptop load and verification

The user reported lag during testing. A process snapshot showed the full ESLint run at 124.6% CPU and this task's development Electron host at 32.2%, alongside other active workloads. This is not a controlled measurement and cannot attribute the lag to one cause. The development host and a leftover failed probe were stopped. Subsequent checks run sequentially at low scheduling priority; lifecycle tests use synthetic time and perform no screen capture.

`test-control-preview-state.ts` verifies independent task state, one subscription for two consumers, zero idle polling, event-triggered wakeup, zero hidden polling and release cleanup. `test-control-previews.ts` verifies hidden capture suppression, one in-flight capture, task ownership, revocation, idle video-source expiry and retention limits.

The production overlay rendered two independent task previews and advancing native video in an Electron fixture while preserving the frontmost application. Evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-chat-preview-WLF5mP/result.json`. That run preceded the subsequent idle and visibility fixes, which are covered by the lifecycle regression checks. It is functional evidence, not a comparative performance benchmark.

There is no measured basis yet for claiming equal or better CPU use, latency or reliability than Codex, CUA, Screenpipe or Peekaboo. A matched short capture benchmark is still needed before making that claim.

Final checks after these changes: `npm run test:mcp`, `npm run test:accounts`, TypeScript project build and `npm run build` pass. `npm run lint` passes; Oxlint reports no warnings or errors, and ESLint retains the two existing TanStack Virtual compiler warnings. No lint rules were disabled. The real capture test host remains stopped.

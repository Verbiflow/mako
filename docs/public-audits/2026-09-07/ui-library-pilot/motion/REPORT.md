# Mako motion pilot: source evaluation and isolated checks

Investigation date: 2026-09-07 America/Los_Angeles. Scope: Danilaa1/slot-text, emilkowalski/sonner, emilkowalski/vaul, and the current Mako working tree. This is an evaluation, not a Mako implementation or release approval.

All clones, downloaded package tarballs, registry metadata, installs, probes, and this report live in `/tmp/mako-ui-pilot-motion/run-rmXgMt/`. Nothing was put in `ignore/`. No Mako source, dependencies, lockfile, or audit artifacts were edited. Mako already had extensive uncommitted work when inspected. Findings describe the working tree at inspection, not solely its HEAD.

## Decision

- **Sonner: use the existing published package.** Own operation identity, retry semantics, focus-safe lifetimes, command integration, and Mako styling. Rebuilding stacking, announcements, and promise transitions has little payoff.
- **Slot-text: approve a bounded comparison pilot; prefer custom whole-label motion as the production baseline.** Keep the package candidate for short occasional feedback. Its width animation, interruption semantics, typography, and missing reduced-motion policy need explicit evaluation.
- **Vaul: approve a handle-only comparison pilot, not unchanged 1.1.2 adoption for adaptive desktop panes.** Existing Radix plus a small custom side-sheet is the preferred desktop approach. Vaul becomes more valuable if snap points, nested sheets, mobile keyboards, and scroll-to-drag handoff become actual requirements. Its maintenance status alone is not the decision.

## Revisions and compatibility verified

| Repository | Inspected HEAD | Published package revision | Compatibility evidence |
| --- | --- | --- | --- |
| [slot-text](https://github.com/Danilaa1/slot-text/tree/209795b60a195013e79849abc809ad0d576e2d75) | `209795b60a195013e79849abc809ad0d576e2d75` | 0.3.4, same gitHead | MIT; no runtime dependencies; ESM; separate React export and required stylesheet; optional React peer `>=18 <20`. |
| [sonner](https://github.com/emilkowalski/sonner/tree/8e4662b39255120b62138312058f5d77c0139a5e) | `8e4662b39255120b62138312058f5d77c0139a5e` | 2.0.8, `ecce1841c55e4a72dfe139a8992b56498660125e` | MIT; no runtime dependencies; React/ReactDOM 18 or 19 peers; ESM and CJS. HEAD differs only in README/package metadata, not runtime source. |
| [vaul](https://github.com/emilkowalski/vaul/tree/3e97aac6a38e4481bade71d7233ed6002e80f9b0) | `3e97aac6a38e4481bade71d7233ed6002e80f9b0` | 1.1.2, `6ba4c44ad99fdfec7def4fa47cabd229fc261965` | MIT; React/ReactDOM 16.8 through 19 peers; ESM/CJS; dependency `@radix-ui/react-dialog:^1.1.1` and its transitive dependencies. HEAD includes material code fixes absent from 1.1.2. |

Registry metadata was fetched directly from `https://registry.npmjs.org/{name}` and saved as `{name}-registry.json`; published tarballs are `{name}.tgz`. Both older gitHeads were fetched into their respective clones. Reproduce release comparisons with `git -C sonner diff ecce1841c55e4a72dfe139a8992b56498660125e HEAD` and `git -C vaul diff 6ba4c44ad99fdfec7def4fa47cabd229fc261965 HEAD` from the report directory.

Mako HEAD: `a5bde7b76cdc0eb30fa1abf42eacb15456ab73f1`. Its lockfile resolves React and ReactDOM 19.2.8, Sonner 2.0.8, `radix-ui` 1.6.7 and `@radix-ui/react-dialog` 1.1.23. The inspected manifest uses TypeScript ~6, Vite ^8 and Electron ^43.4.0. All three packages passed a strict TypeScript 6 consumer check against React 19.2.8 without `skipLibCheck`. This proves the exercised public APIs typecheck; it does not prove renderer performance, Electron focus behavior, or all library API combinations. Vaul's Radix range can share Mako's resolved dialog version; actual future lockfile deduplication still needs checking.

## Findings table

| Before, verified in source unless stated otherwise | Recommended pilot behavior | Why |
| --- | --- | --- |
| Slot-text defaults to per-character 300ms motion with 45ms stagger and bounce 0.6. | Word mode, no hue effect, no stagger/bounce; compare against complete-label 180ms entry/120ms exit. | Stagger compounds over label length; Mako requires entrances under 250ms and only its two curves. |
| Slot-text `interrupt:true` settles the old target before starting the new transition. | Custom transitions that retarget current transforms, or explicitly test the library's latest-only queue. | Cancellation is implemented, but continuous visual interruption is not. |
| Slot-text changes measured cell widths; Mako has no existing `.status-swap` consumers despite defining the CSS. | Reserve label space and move only the text layers. | Avoid creating layout work beside a busy streaming transcript. |
| Sonner defaults include 400ms transform/height transitions and 500ms swipe motion. | Token-based entrance below 250ms, faster exit, bounded content and stack. | Existing Sonner dependency does not imply its stock motion satisfies Mako rules. |
| Sonner keyboard focus alone did not stop expiry in the isolated DOM probe. | Make actionable failures persistent, or implement and verify explicit focus pause. | A focused Retry button must remain available. |
| Vaul 1.1.2 does not forward `modal` to Radix Root; HEAD does. | Use existing Radix directly, or carry the specific fix in a maintained Vaul fork. | Public `modal:false` cannot be assumed to make the published underlying dialog nonmodal. |
| Vaul uses 500ms motion and several matching JS timers; it has no own reduced-motion branch. | Coordinate animation, completion, cancellation and reduced motion in one lifecycle. | A CSS duration override alone leaves delayed callbacks and snap resets. |
| Mako Divider handles pointercancel but lacks keyboard resizing and unmount cleanup. | Include focusable separator keys, pointer ownership and teardown in the panel pilot. | Existing custom code also has ownership costs. |

## Slot-text: source observations

Exact source references at the pinned revision:

- [`src/react.ts:24`](https://github.com/Danilaa1/slot-text/blob/209795b60a195013e79849abc809ad0d576e2d75/src/react.ts#L24): imperative DOM beneath a React-owned span, current options in a ref, text-triggered effect, `clearSlotText` on cleanup. Adapter supplies `aria-label`; it initially renders an empty span until the effect runs. It does not automatically announce changes.
- [`src/slotText.ts:99`](https://github.com/Danilaa1/slot-text/blob/209795b60a195013e79849abc809ad0d576e2d75/src/slotText.ts#L99): timers are owned in a WeakMap and cleared on cancellation. `finishRunningAnimationImmediately` renders the prior target. With `interrupt:false`, only the latest pending target is retained, not an unbounded queue. Completion has a timer fallback, so it does not rely solely on `transitionend`.
- [`src/slotText.ts:225`](https://github.com/Danilaa1/slot-text/blob/209795b60a195013e79849abc809ad0d576e2d75/src/slotText.ts#L225): measurement/preparation is batched, followed by an explicit layout flush. This is better than interleaving each glyph's reads/writes, but still requires layout.
- [`src/dom.ts:37`](https://github.com/Danilaa1/slot-text/blob/209795b60a195013e79849abc809ad0d576e2d75/src/dom.ts#L37) and `:270`: sizer and animated faces, measured widths, transform/width transitions, transition listeners; faces are replaced on finalization/cleanup. The layout probe is aria-hidden, but real animated faces are not individually hidden. The React span's aria-label is not sufficient evidence of correct screen-reader behavior across platforms. Recommend a named outer button with the visual subtree aria-hidden and a separate deliberate status announcement.
- `src/index.ts:65–119`: flash calls default to noninterrupting rolls, repeated flashes reset the revert timer, explicit set cancels the revert, destroy cancels and restores text. Useful behavior worth preserving in either candidate.
- `src/text.ts`, `src/constants.ts`, `src/timing.ts`, `style.css`: grapheme segmentation via Intl.Segmenter with code-point fallback; word mode preserves shaping inside words. Character cells lose kerning/ligatures and joined-script shaping. No reduced-motion handling was found in source or stylesheet. No font-loading/resize observer was found to refresh already measured animation cells.

Recommendation: use this only for isolated semantic changes, never token counts, cost increments, rail activity churn or palette navigation. A reduced-motion wrapper should choose plain text before animation code runs. Mako's global CSS suppression does not cancel the library's timers or prevent it building outgoing/incoming DOM. Test late font load, 200% zoom, Arabic and emoji. No chromatic/rainbow option in Mako.

Custom ownership is small for a finite state pair: two complete text layers, stable outer accessible name, reserved intrinsic maximum width, transition styles, one reset timer and teardown. Generic variable-length text, font measurement and cross-script animation would erase that simplicity. The prototype intentionally handles a fixed pair, not arbitrary morphing text.

## Sonner: source observations

- [`src/state.ts:15–164`](https://github.com/emilkowalski/sonner/blob/8e4662b39255120b62138312058f5d77c0139a5e/src/state.ts#L15): external observer, stable IDs, pre-subscription replay, pending-dismissal cancellation, dismissed-history trimming. History target is 100, but active toasts are retained even beyond that count; visibleToasts is not an admission/queue bound. Promise lifecycle is at `:196–304`. Do not assume promise settlement understands domain failure envelopes: reject/map failures at the operation boundary.
- [`src/index.tsx:149–243`](https://github.com/emilkowalski/sonner/blob/8e4662b39255120b62138312058f5d77c0139a5e/src/index.tsx#L149): height measurement on mount/content changes; lifetime remainder pauses for expansion, pointer interaction and hidden document. Expiry timer has cleanup. Removal schedules an untracked 200ms timeout. Toaster subscription also schedules untracked timeout/rAF work around flushSync at `:665–697`.
- `src/index.tsx:316–421`: pointer capture, directional swipe, distance/velocity dismissal and damping. It writes swipe CSS variables on the toast; this is not evidence of zero style recalculation. Do not send a toast per token/tool event.
- `src/index.tsx:699–742`: system theme registers a media-query change listener with no matching removal. Mako can pass a resolved light/dark theme from next-themes instead of entering that path. This is source evidence of a cleanup omission, not a measured retained-heap result.
- `src/index.tsx:753–854`: removable Alt+T listener, polite live region, focusable toast/list and previous-focus bookkeeping. On focus alone it records focus but does not expand or set interacting. The isolated probe confirms that focus alone does not hold the toast open. Hotkey activation expands, which does pause. Mako should disable the package shortcut via `hotkey={[]}` and expose notification focus through the command registry, with a supported focus target. Internal Escape handling can remain local to the widget.
- [`src/styles.css:708`](https://github.com/emilkowalski/sonner/blob/8e4662b39255120b62138312058f5d77c0139a5e/src/styles.css#L708): reduced-motion query disables toast animations/transitions. Mako's own global rule also changes transitions, so verify computed styles after both stylesheets load. Default dimensions, font weights, shadows and motion are not all covered by Mako's existing background/text/border variables.

Integration: `/Users/kashyab/pi-ui/src/App.tsx:9` mounts one bottom-right Toaster, offset 16. `/Users/kashyab/pi-ui/src/components/ui/sonner.tsx:28` supplies theme, icons and a `cn-toast` class; no `cn-toast` styling was found in `src/index.css`. Keep one toaster and author token-based overrides in `src/index.css`, including 13px UI/11px label text and 440/530/640 weights. Shadows belong on this floating surface, never the shell. Make toast buttons pressable. Avoid covering the composer or terminal controls at narrow widths.

Own a bounded operation notification policy keyed by workspace/thread plus operation attempt, not just the currently visible tab. Repeated updates retain one ID; retries get a new attempt identity to prevent a stale completion from overwriting the new run. Closing a notification is not cancellation. Capture the original operation context in Retry/Open actions, and only expose Undo for genuinely reversible actions. Keep important errors in the relevant panel as well.

## Vaul versus custom Radix: source observations and maintenance burden

- [`src/index.tsx:759`](https://github.com/emilkowalski/vaul/blob/3e97aac6a38e4481bade71d7233ed6002e80f9b0/src/index.tsx#L759): HEAD adds `modal={modal}` to Radix Root. HEAD also moves Overlay's useCallback before its conditional return at `:805`. Both fixes are absent from published 1.1.2. This materially affects an adaptive nonmodal panel and changing modality. The package still declares the same version, so name/version alone does not identify fixed source.
- [`src/index.tsx:261–355`](https://github.com/emilkowalski/vaul/blob/3e97aac6a38e4481bade71d7233ed6002e80f9b0/src/index.tsx#L261): pointer capture, scroll selection arbitration and no-drag areas. Critically, left/right directions return true before checking highlighted text and scrollable ancestors. Use `handleOnly` for a diff, file viewer or terminal-like content. The Content path handles pointerup/out/contextmenu; the Handle has explicit pointercancel handling at `:1073`. Multi-pointer ownership/lost capture should be tested rather than assumed.
- `src/index.tsx:599–659`, `src/constants.ts`: velocity threshold 0.4 px/ms, distance threshold 25%, drag release and reset. These are heuristics, not a continuous velocity-preserving spring. Motion interruption must be exercised with reversal during snap/close.
- `src/use-snap-points.ts:36–123`: controlled snap state, pixel or fraction points, window resize observation, container measurement and inline transform transitions. A container-only resize is not observed directly; Mako's independent dock and panes can resize without window resize. Preserve pixel sizing for Mako and explicitly bridge container changes if adopting this.
- `src/index.tsx:474–533`, `src/use-position-fixed.ts`, `src/use-prevent-scroll.ts`: virtual-keyboard viewport work, Safari body positioning/restoration and reference-counted scroll locks. Main resize/scroll listeners have cleanup. Several delayed body updates, animation-end callbacks, snap resets and nested transitions lack lifecycle-wide timer cancellation. The once-only touchend callback can remain pending until a touchend arrives. Rapid close/reopen and unmount are concrete tests, not proof of universal leakage.
- `src/index.tsx:168`, `:925`: autoFocus defaults false and prevents Radix opening focus. Dialog title/description, focus destination and restoration need explicit integration. Set deliberate initial focus for a covering panel; retain normal workspace focus for a nonmodal beside pane.
- `src/style.css:1–86`, `src/constants.ts`: 500ms entrance/exit keyframes plus transitions; JS completion timers use the same duration. No reduced-motion policy found. Root defaults shouldScaleBackground=false, which fits Mako. Keep square edges, no shell shadow and no background scale. A stylesheet-only speed patch would leave JS callbacks and the 500ms drag-opening gate out of sync.

**What a Vaul fork would own:** carry the two post-release fixes; constrain supported props; unify timing and cancellation; add reduced motion; maintain horizontal selection/drag behavior, pointer cancellation, container resize, Radix compatibility and nested focus/scroll restoration. If mobile input support is claimed, also own Safari/Android device regression testing. Vendoring the entire source into Mako would introduce many casts/anys and hook/lint issues. An external fork package can isolate upstream implementation, but does not excuse weak Mako boundaries or unsafe behavior.

**What custom Radix would own:** stage presentation rules; one stable panel subtree; pixel widths; a handle-only pointer state machine; transform displacement; recent velocity/distance decision; snap-back/close transition; capture cancellation; focus/inert policy when covering; cleanup; reduced motion. Radix continues to own dialog semantics, focus scope and modal dismissal where appropriate. Beside mode remains an ordinary workspace pane. Avoid switching between unrelated parent trees at the breakpoint, which would remount panel content. This is less ownership for Mako's current desktop behavior because it excludes nested snap stacks, body scaling and mobile keyboard repositioning. If those become requirements, reassess Vaul rather than gradually reproducing its entire machinery.

Current Mako integration points:

- `/Users/kashyab/pi-ui/src/components/stage/stage.tsx:68`: ResizeObserver, then derived beside/cover mode. Workbench stays mounted but receives `hidden` while covered. Preserve drafts, transcript scroll, file tabs and selections across the new presentation.
- `/Users/kashyab/pi-ui/src/components/stage/stage-width.ts:10`: chat minimum 450px, default companion minimum 380px, divider 1px. Default fit threshold is 831px of stage width, not full window width. Surface-specific minWidth changes it. Stored desired width survives temporary clamping.
- `/Users/kashyab/pi-ui/src/components/shell/divider.tsx:35`: ref-based pointer drag writes at most once per animation frame; commit stores the final value. Good baseline. It has no tabIndex/keyboard handler, no lost-capture handling or unmount cleanup for listeners/body cursor/user-select. Pointercancel currently commits the latest size; decide that policy explicitly.
- `/Users/kashyab/pi-ui/src/state/stage.ts:47`, `/Users/kashyab/pi-ui/src/extend/surfaces.ts:31`, `/Users/kashyab/pi-ui/src/desk/builtins.tsx:52`: retain domain actions and registered surfaces. Do not introduce provider switches, direct component bridge imports, a second transcript renderer or a percentage split. Terminal remains an independent bottom dock.

## Nine concrete uses for the pilot

These are recommendations, not implemented or verified product behavior. They are nine uses across the three evaluated libraries, not a claim to have evaluated six additional libraries.

| Pilot use | Integration point in `/Users/kashyab/pi-ui/` | Candidate and acceptance gate |
| --- | --- | --- |
| 1. Whole-answer Copy answer → Copied answer → Copy answer | `src/components/transcript/exchange.tsx:543` | Slot-text word mode versus custom whole label. Restart the one 1400ms feedback timer after repeat clicks; clear on unmount. Current code creates a fresh untracked timeout each click. Confirm copy success before success feedback. |
| 2. Commit-message generation status | `src/components/inspector/commit-box.tsx:38` | Whole-label custom preferred, slot-text contender: Generate message → Drafting message → Message ready. Preserve draft text and focus; failure does not animate a success state. |
| 3. Provider connection/stopping status | `src/components/viewer/acp-panel.tsx:121`, `src/components/viewer/thread-viewer.tsx:344` | Complete-label transition for semantic phases only. Coalesce rapid intermediate status changes, keep urgent stopping/error text current, and keep token/queue counts static. Provider-neutral wording. |
| 4. Explicit push lifecycle in one notification | `src/components/inspector/commit-box.tsx:174` | Existing Sonner: Pushing branch → Branch pushed or persistent failure with Retry. Bind to original repository. Commit never implicitly pushes. |
| 5. Pull-request creation lifecycle with Open action | `src/components/inspector/pull-request.tsx:302` | Existing Sonner updates one operation ID and shows the actual created PR. Late results cannot target the newly selected workspace. Duplicate clicks create one operation. |
| 6. Plugin load failure aggregation | `src/extend/use-plugins.ts:42` | Existing Sonner groups repeated failures by plugin/load attempt; retain actionable detail. Retry only if a real domain action exists. Bound active notifications; do not re-execute arbitrary UI extension code from a stale toast closure. |
| 7. Changes panel becomes a handle-dismissable cover at narrow stage widths | `src/components/stage/stage.tsx:117`, `src/state/stage.ts:47` | Custom Radix versus fixed Vaul HEAD/fork, direction right, handleOnly, no scaling. Diff text selection and horizontal scrolling cannot drag it. Restore preferred beside width when space returns. |
| 8. Context/Files inspection with explicit return to workbench | `src/desk/builtins.tsx`, `src/components/stage/stage.tsx:170` | Same adaptive panel controller, registered content. Focus moves into cover and returns to the trigger; drawer never clears composer drafts or remounts file tabs. |
| 9. History review and return gesture while Terminal stays open | `src/desk/builtins.tsx`, `src/components/stage/stage.tsx:198` | Same controller. Gesture dismisses the reading panel only; it never forks/rewinds a conversation. History actions remain deliberate. Terminal height and running session survive. |

## Executed checks, exact commands and results

Commands below ran only against isolated dependencies except the explicitly identified read-only Mako lint command.

| Working directory | Exact command | Count and observed result |
| --- | --- | --- |
| `slot-text/` under this report directory | `npm ci --ignore-scripts --no-audit --no-fund` | One isolated install, exit 0. Log: `slot-install.log`. |
| `slot-text/` | `npm test` | **One invocation; 3 test files passed, 35 tests passed, 0 failed.** Vitest 4.1.8, happy-dom. Reported duration 603ms. |
| `slot-text/` | `npm run check` | One invocation; TypeScript noEmit check passed, exit 0. |
| `slot-text/` | `npm run build` | One invocation; generated isolated dist successfully, exit 0. |
| `probe/` | `./node_modules/.bin/tsc --noEmit --strict --jsx react-jsx --module esnext --moduleResolution bundler --target es2022 --lib es2022,dom compat.tsx` | Two invocations, both passed without diagnostics. One consumer fixture exercises all three published packages. |
| `probe/` | `./node_modules/.bin/tsx lifecycle.tsx` | Two attempts. First failed before running checks because the fresh package defaulted to CJS and the probe uses top-level await. After adding type:module to isolated probe/package.json, second exited 0. Loading→success retained exactly one DOM toast and updated its title. Direct keyboard focus did **not** retain a short-lived toast. |
| `/Users/kashyab/pi-ui` | `npm run lint` | One invocation, exit 0. ESLint: **0 errors, 2 warnings** for existing TanStack useVirtualizer compiler exclusions at `src/components/rail/file-tree.tsx:57` and `src/components/search/search-view.tsx:217`. Invoked `npm run lint:anti-slop`: no warnings/errors emitted, exit 0. This is not a claim of zero ESLint warnings. Full log: `mako-lint.log`. |

Slot-text's upstream suite covers CSS fallback, markup, grapheme/word segmentation, interrupted ownership, queued updates, flash/reset/destroy behavior, timing, and Solid/Svelte adapters. It does not provide browser typography/performance evidence or a React StrictMode rendering test. Sonner's and Vaul's Playwright suites were inspected but not run. The Sonner probe used happy-dom; it is a lifecycle reproduction, not a screen-reader or real-browser focus certification.

## Isolated A/B prototype

Source: `/tmp/mako-ui-pilot-motion/run-rmXgMt/probe/labels.html`.
Live local URL while the supplied server runs: http://127.0.0.1:8769/probe/labels.html
Restart with:

```sh
python3 -m http.server 8769 --bind 127.0.0.1 --directory /tmp/mako-ui-pilot-motion/run-rmXgMt
```

Uses built pinned slot-text in word mode versus two whole-label CSS-transition layers. Both get outer accessible names and aria-hidden visual subtrees. Reduced-motion switches the library to plain text. Controls trigger both samples, with a ten-update/60ms burst option. It does not access the clipboard or Mako state.

**Verified in the in-app browser:** page loaded, both labels rendered; clicking Copy changed both accessible names and visible text to Copied answer; later inspection showed the return to Copy answer. The burst control was clicked and the observed result was Copy answer in both. A screenshot of the settled success state was inspected. This does not establish frame timing, absence of mid-burst jumps, or reduced-motion behavior. The custom sample reserves 9em as a prototype convenience; production should derive stable space from actual label variants and font metrics. Prototype is independent HTML using system UI type, not a claim to reproduce Mako's Geist typography exactly.

## Acceptance tests to run before any Mako integration approval

These are proposed tests; none are claimed as passed unless separately listed above.

1. **Labels and identity:** repeat Copy 20 times at 50–100ms intervals; switch sessions/unmount during the roll; final label is current and revert happens once after the latest action. A→B→C transitions show no jump to a stale target. Test React StrictMode and options changes. Validate Arabic, combining marks, ZWJ emoji, 200% zoom and late Geist loading.
2. **Accessibility/reduced motion:** VoiceOver announces one logical label/status, never both faces. Toggle reduced motion during a transition and while idle; no delayed movement returns. Label movement is absent for rapid keyboard navigation and palette use. Test actual stylesheet ordering, not just the presence of a media query.
3. **Notification lifecycle:** loading→success/error remains one toast per operation; out-of-order completion from attempt A cannot replace attempt B; switch workspace before Retry/Open and verify the original context. Explicit dismiss, timeout and operation cancellation remain distinct. Verify focused action survives its original deadline, hidden-window pause preserves remaining time, and focus returns predictably.
4. **Notification load/cleanup:** generate 100 distinct failures, then repeated updates; active DOM and retained history follow an explicit bound. Unmount/remount Toaster with pending dismissals and switch themes repeatedly; assert listener/timer counts return to baseline. Test variable-height errors and viewport resize. All actions remain reachable when collapsed.
5. **Adaptive layout:** cross the applicable `450 + minWidth + 1` stage threshold repeatedly and resize the dock without resizing the window. No stored width is overwritten by temporary clamping; no panel/workbench subtree remounts; draft, selection and scroll survive. Read pane continues using its registry definition.
6. **Gestures:** drag only from the handle; highlight long diff lines, horizontally scroll code, use nested scroll areas and select menus without moving the panel. Test reverse flick, low-distance high-velocity flick, slow insufficient drag, second pointer, pointercancel, lost capture, close/reopen during snap-back, and unmount during drag. Body cursor/user-select/pointer-events/scroll settings must restore.
7. **Panel accessibility:** keyboard separator resizing with arrows/Home/End and announced current value; explicit close/return controls; Escape routing with nested dialogs; initial/restored focus; hidden workbench excluded from interaction while covered. Gesture never performs History fork/rewind or cancels a terminal.
8. **Real Mako performance:** use the real local host URL without `?mock`, open existing native threads without starting an agent, then replay deterministic streaming in an isolated fixture when needed. Profile label/toast/panel motion against token bursts. Narrow selectors must keep rail, titlebar and unrelated exchanges asleep. Measure frame-time/layout costs rather than claiming compositor-only performance from property names.
9. **Repository gates:** before a source-changing handoff run the appropriate stage/web checks plus npm run lint. Require zero anti-slop warnings/errors; account explicitly for any existing ESLint warnings. No new provider branches, bridge imports from components, token colors outside index.css, nested session trees, or new transcript renderer.

Final disposition: approve the three bounded comparison pilots above. Block unchanged stock motion settings and unsupported claims of accessibility/performance readiness. Production choice remains Sonner package, custom whole labels, and custom Radix desktop side-sheet unless the Vaul comparison demonstrates enough required gesture behavior to justify its larger maintenance scope.

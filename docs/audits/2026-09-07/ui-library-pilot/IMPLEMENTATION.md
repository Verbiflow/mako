# Implemented UI pilot

The warm palette remains intact. The opening heading now scales from 22 to 30px, and conversation prose is 15px with a 1.65 line height. Geist remains the UI and reading face; code uses the platform monospace.

## What shipped

- **Background texture:** a custom Bayer field behind the opening screen. It settles in 220ms, uses at most a 480×320 raster, redraws on size/theme changes, and cancels scheduled work when hidden or unmounted. Reduced motion draws a static field. The transcript itself has no animated background.
- **Usage:** taller stippled bars use actual daily costs. The chart labels its daily peak and exposes every day/value through its accessible description. Reported costs, estimates, and unknown pricing keep their existing distinctions.
- **Audio:** one opt-in controller owns synthesis, a selected Kenney CC0 sample, a master gain, active voices, and one shared decode promise. Muting, zero volume, disposal, and preference changes suppress pending playback. Replacing a cue releases both its source and envelope. The copy cue is an original synthesized recipe; the completion sample came from Soundcn's Kenney source assets. Neither upstream runtime is installed.
- **Completion signals:** accepted live batches produce a cue only when the same request changes from `dispatching` to `completed`. Snapshots establish state silently. External activity disappearing does not imply successful completion.
- **Clipboard:** code, tool output, and whole-answer copy share an asynchronous hook. They confirm only after success, invalidate pending results when the displayed text changes, and clean up timers on unmount. A refused copy has a persistent Retry notification; a later success dismisses it.
- **Notifications:** Sonner follows Mako's resolved theme. Its shortcut is registered in the command registry. Toasts sit top-right under the titlebar and leave after three seconds; toasts with actions stay `ACTION_TOAST_MS` (8 s) and none stays forever, enforced by `scripts/check-actionable-toasts.mjs` in `npm run lint`. Short label transitions use native React text and finite CSS animation rather than imperative DOM replacement.
- **Panels:** the desktop implementation retains the workbench when covered, keeps preferred widths, and adds keyboard resizing, pointer-capture cleanup, interrupted-drag cleanup, and short entrances. Arrows resize by 10px, Shift by 40px, Home/End reach the limits. Reduced motion disables entrances.
- **Text layout:** native `field-sizing: content` handles the composer, with the previous measurement path retained for engines without support. Pretext 0.0.9 loads only for settled, plain paragraphs of 512–8,192 characters from the existing Markdown tree. It seeds a native intrinsic-size estimate; the browser still lays out and selects the actual text. Styled runs, links, tables, and streaming content bypass estimation. Prepared text is bounded to 128,000 retained key characters, with the library's shared cache cleared at the same boundary. A one-line allowance covers the known benchmark undercount; estimates are not a pixel-exact rendering contract.

Pretext and sample notices are also copied to `public/licenses/` for distribution. `next-themes` was removed because the toaster was its only consumer.

## Panel choice

| Concern | Published Vaul 1.1.2 | Corrected Vaul source | Mako desktop implementation |
| --- | --- | --- | --- |
| Nonmodal root | Audited modal-forwarding defect | Forwards the modal setting | Ordinary nonmodal workspace panes |
| Motion lifecycle | CSS and JavaScript teardown timers | Modal fix does not remove this coupling | Pointer-driven resize; finite CSS entrance; immediate cleanup |
| Workspace state | Drawer integration needs separate preservation | Still needs desktop integration | Existing workbench stays mounted through cover/restore |
| Resize semantics | Primarily drawer gestures | Still drawer gestures | Focusable separators, arrows, limits, pointer capture |

The Vaul columns are source-review findings, not a claim that its full browser suite was run. The Mako column was exercised in the real UI and the component regression page. The published or patched Vaul runtime is not added to the application.

## Verification

Run the code checks:

```sh
node --import tsx scripts/test-ui-feedback.mjs
node scripts/check-actionable-toasts.mjs
npm run test:stage
npm run typecheck
npm run lint
npm run build
```

With the development server running, open `/scripts/ui-pilot-browser.html` on its printed URL and select **Run UI regression checks**. This explicit fixture page imports production components and uses a fixture clipboard. It never starts an agent.

Observed browser results passed for paragraph estimates at 360/640/900px, unchanged text and GFM tables, streaming bypass, prepending 30 exchanges with 0px reading-anchor movement, paragraph estimates yielding to scroll-preservation guards, delayed/refused/stale clipboard results, persistent actionable errors, successful retry cleanup, label styles, keyboard resizing, drag teardown, bounded dither dimensions, no frames after settling, reduced motion, and immediate cancellation on document hide. Synthetic drag checks stub only pointer capture because synthetic pointer events do not allocate a native pointer; real pointer/keyboard interaction was checked separately.

Real-host UI checks at 1280×800 and 900×800 confirmed sidebar cover/restore retained a 21-line draft. The native textarea and reference overlay both measured 437px inside a 320px scroller. Right-sidebar keyboard resizing changed 500px to 510px and back. Dark/light themes and the sound switch/preview controls were exercised. The test draft was cleared and sound returned to off.

The full lint command passed with zero Oxlint diagnostics. ESLint retains the two pre-existing React Compiler warnings for isolated TanStack virtualizers in `file-tree.tsx` and `search-view.tsx`.

The browser fixture also emitted two `ResizeObserver loop completed with undelivered notifications` messages while exercising layout changes. All assertions completed successfully; the source of those deferred notifications has not been isolated.

This is a bounded integration pilot, not a claim of universal Pretext accuracy or a whole-application performance speedup. The earlier benchmark's long-identifier witness and research reports remain in this directory.

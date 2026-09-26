# Pretext investigation for Mako

Primary recommendation: use Pretext to supply width-specific offscreen exchange height estimates to the existing `content-visibility` renderer. For composer autogrow, pilot native `field-sizing: content` first. The benchmark supports cheap repeated layout, but does not support cold preparation on every keystroke.

Inspected Pretext commit `8460bf940c50d82be90a396fb0ea2c4e7a2dc6f3`, cloned at `/tmp/mako-ui-pilot-pretext`. Mako HEAD was `a5bde7b76cdc0eb30fa1abf42eacb15456ab73f1`, with existing working-tree changes, including composer.tsx. Findings describe that working tree. No Mako source was edited.

## Runnable evidence

Open http://127.0.0.1:43917 and click Run benchmark. Restart with:

```sh
node /tmp/mako-ui-pilot-bench/serve.mjs
```

`standalone.html` embeds the font and library bundle; it also runs independently from disk. `browser.js` is the readable experiment, `results.json` is the last browser result, and the complete result appears in DOM element `#result`. The loopback server saves results to this directory. Rebuild after changing the experiment:

```sh
bun build /tmp/mako-ui-pilot-bench/browser.js --target browser --outfile /tmp/mako-ui-pilot-bench/bundle.js
python3 /tmp/mako-ui-pilot-bench/make-standalone.py
```

All browser execution and observation used CUA. Final observed environment: Chromium 152, DPR 2, 1280×720, font loaded, visible and focused at start. These are diagnostic samples, not a continuous foreground/environment-guarded performance certification.

| Measurement | Final observed result |
| --- | --- |
| Paragraph fixtures | 65/66 matching line counts |
| Pretext textarea adapter, 1px tolerance | 78/80 |
| Native field-sizing vs current textarea autogrow, 1px tolerance | 80/80 |
| Cold prepare, 500 paragraphs, median of 7 | 104.60ms |
| Warm layout, per 500 paragraphs, normalized over 100 batches | 0.712ms |
| DOM batch width writes, then height reads | 4.40ms |
| DOM interleaved width write/height read | 59.60ms |
| 120 growing prefixes, final 24,800 characters, full prepare+layout | 1455.30ms total |
| Same prefixes, DOM text assignment + height read | 112.60ms total |

Warm relayout was approximately 6.2× faster than batched DOM reads in this sample. Do not compare cold preparation against warm DOM as if both start from an empty application. Font and JIT caches remain warm; only Pretext shared caches are explicitly cleared. Repeated plain-paragraph caching also runs, but its later cache state and repeated text make it an illustration, not a fair speedup claim.

The 5,024-character Geist identifier at width 360 has 95 DOM lines versus 94 predicted, a 22.25px height underestimate. It reproduces with either `overflow-wrap: anywhere` or `break-word`, and with `ss01`/`ss03` on or off. The two remaining textarea failures are `AVffi` repeated 100 times in the requested 14px font, at outer widths 80 and 360, with content widths 56 and 336. Errors are -44.6px and -22.4px. The same fixture at current Mako 13px passes the sampled widths. Passing heights do not prove identical line break positions or caret geometry.

Textarea tests cover empty strings, a newline alone, final newline, tabs, whitespace-only input, long words and multilingual text at 80/120/360/640/900. They reproduce `height=0; scrollHeight; height=scrollHeight`, padding and minimum height. A corrected adapter reserves one editable line for empty input and explicitly adds the final line after a trailing newline. A zero-width-space sentinel did not reliably reserve it; its failed estimate remains in the JSON. Native field-sizing needs no such approximation.

## What the package actually provides

- `src/layout.ts:438` runs normalization/segmentation/measurement on every prepare call. `prepare` at 464 returns an opaque handle; `layout` at 487 computes line count and multiplies caller-provided line height. It has no append/update API. Reusing a handle across widths is the central performance benefit.
- `src/analysis.ts` uses `Intl.Segmenter`, whitespace normalization and script/punctuation glue rules. `src/measurement.ts:34` prefers OffscreenCanvas, otherwise DOM canvas. It caches measured segments by font in unbounded Maps at lines 20–59. `clearCache` in `src/layout.ts:686` releases shared caches, but retained prepared handles remain caller-owned.
- `src/measurement.ts:126` can perform a cached DOM emoji calibration. Therefore preparation is not unconditionally DOM-free. Browser-specific tolerances and wrap policies live at line 71. Fractional browser line-box rounding also matters when accumulating thousands of lines.
- `src/layout.ts:280` chooses prefix measurement for nonzero tracking. `src/measurement.ts:178` caps prefix shaping at 96 graphemes and uses pair-context advances above that. Contextual shaping approximation is a plausible explanation for the long-word witness, not a proven root cause. Changing CSS wrap mode/features did not fix it.
- `prepareWithSegments`, line ranges, cursors, stats and natural-width APIs support custom line placement without allocating every line string. `src/line-break.ts:316` owns the numeric count path; line range materialization uses weak caches in `src/line-text.ts`. Cursor positions are segment/grapheme coordinates, not Markdown source offsets. Bidi metadata is explicitly approximate, and does not make a complete custom caret/selection renderer.
- `src/rich-inline.ts:27` supports per-item fonts, tracking, atomic items and caller-supplied horizontal chrome. It models normal whitespace only. It does not implement nested block layout, CSS margin collapse, table sizing, inline vertical alignment or all shaping across styled boundaries.
- `pages/demos/markdown-chat.model.ts:243` prepares 10,000 repeated seed messages; line 259 builds message geometry and line 310 finds visible ranges. This is useful prior art for block geometry, not an end-to-end Mako benchmark. Its parser uses `marked` at 355, and converts tables to code blocks at 413. Mako has real GFM tables and citation buttons, so copying the demo changes behavior.
- Package metadata: `@chenglou/pretext` 0.0.9, MIT, ESM, declarations, `sideEffects:false`, no runtime dependencies, root and `/rich-inline` exports. Local build and dry pack succeed: 69 entries, 256,148 compressed bytes, 887,142 unpacked bytes. Packed demos/assets contribute to that size; it is not the tree-shaken renderer cost. Registry metadata also reports 0.0.9, but the experiment uses the pinned clone, not an assumed identical npm release. License notices are included beside the prototype; Geist's font license is also included.

## Mako integration architecture

The current bottlenecks and relevant contracts are concrete:

- `/Users/kashyab/pi-ui/src/index.css:359` uses `.contain-turn` with `content-visibility:auto` and `contain-intrinsic-size:auto 120px`. `/Users/kashyab/pi-ui/src/components/transcript/exchange.tsx:77` applies it to each exchange.
- `/Users/kashyab/pi-ui/src/components/transcript/conversation-timeline.tsx:30` initially mounts 30 exchanges, then adds 30. Lines 41–60 and 180–226 force visibility and read geometry to preserve the anchor during prepends. Keep these safeguards until real tests prove estimates can replace specific reads.
- `/Users/kashyab/pi-ui/src/components/transcript/markdown.tsx:20` explicitly documents whole-answer parse cost and invalid blank-line splitting. It throttles streaming parsing to 90ms and uses react-markdown, GFM and file citations. Pretext does not eliminate this parse work.
- `/Users/kashyab/pi-ui/src/lib/reconcile.ts:18` preserves message identity. Use that identity in the geometry cache rather than hashing/repreparing the whole session per token.

Build a renderer-owned block geometry model alongside the existing Markdown projection. Parse through one shared remark/GFM/citation pipeline; derive both DOM and measurement descriptions from it. Compile paragraphs and styled inline runs with Pretext; compose list/quote indents, margins, code headers and exchange chrome explicitly. Measure real table/tool/attachment blocks and store their observed heights by width and expansion state. Do not flatten arbitrary Markdown to plain text and label the result exact.

Cache prepared blocks by content identity, font signature, tracking, whitespace mode and locale. Cache heights separately by available width and layout revision. A single width observation per transcript feeds relayout; per-exchange selectors publish only changed hints. Font readiness, theme typography, code expansion, image dimensions and width changes invalidate the corresponding measurements. No host events, provider branches or IPC changes are needed.

Set an exchange's intrinsic block-size hint to `auto <predicted-height>px` before mounting its offscreen content when the cached prediction is ready. Preserve the `auto` remembered actual size and the existing renderer; use a bounded lookahead/idle preparation budget so loading history does not synchronously prepare hundreds of blocks. This retains browser selection, accessibility and the exchange-level copy contract. Predictions seed layout and are corrected by observed sizes. The browser's remembered size after width changes needs explicit testing; changing a fallback estimate does not necessarily discard that remembered value.

This is an ambitious geometry layer without a second transcript renderer. It can later drive turn-navigator positions and scroll-to-exchange estimates. Font preparation can move to an explicitly font-loaded worker if needed, but worker/main font parity and the DOM-dependent emoji calibration must be tested first.

## Composer and rail decisions

`/Users/kashyab/pi-ui/src/components/composer/composer.tsx:234` resets height and reads scrollHeight on `[draft, expanded]`, then may read the wrapper scrollHeight to reveal the caret. Prefer a `CSS.supports`-gated native `field-sizing:content` pilot with a fixed width, existing min-height and existing external scroller. Remove only the autogrow height mutation in that implementation; caret reveal remains an independent behavior. Preserve the real textarea and mention overlay. CSS sizing does not itself solve caret following.

`reference-overlay.tsx:13` paints matching glyphs behind the transparent textarea, including a final-line sentinel. Share exact font, padding and width metrics between the two layers. Test expanded/collapsed padding, placeholder sizing, selection, IME, middle-of-draft edits and long pastes inside the 320px wrapper. The benchmark tests size, not overlay/caret behavior. Current composer metrics are 13px/20.15px; the requested prose-style 14px/22.4px is a separate test config.

The actual thread rail is currently `session-rail.tsx` → `agent-threads.tsx`, with folder pagination and an 80-result search cap at line 371. `thread-row.tsx:197` truncates single-line titles. Fixed virtualization is in `rail/file-tree.tsx:57` and `search/search-view.tsx:217`. There is little current measurement work for Pretext to remove there. An intentional product expansion to multiline thread previews could use Pretext estimates, but should preserve those bounds.

## Custom implementation path

A Mako-owned block-layout compiler over the existing remark tree is valuable whether it uses Pretext or native measurement. A dependency-free alternative uses batched offscreen DOM measurement, a width-aware bounded height cache, and native field-sizing for the composer. It has stronger CSS fidelity and paid first measurements; compare its 4.4ms warm batch here with Pretext's 0.712ms before choosing where the arithmetic engine earns its preparation cost.

For maximum scope, fork Pretext under MIT to expose incremental paragraph preparation and bounded cache ownership. Reuse unchanged prepared paragraphs; reanalyze the entire affected paragraph and its boundary context, then recompute from the last affected line. Do not concatenate segment arrays blindly: punctuation glue, shaping, whitespace, locale and bidi paragraph state can change at the boundary. Markdown definitions, lists and fences can invalidate earlier parse nodes, so only reuse nodes after dependency-aware validation. This is a substantive custom implementation worth prototyping, rather than a claim that today's `prepare` already supports cheap streaming.

## Gates before integrating

1. Preserve the long-word failures as named regressions; sweep nearby fractional widths, tracking, weights 440/530/600/640, fallback fonts, DPI/zoom and delayed font loading. Require line-boundary as well as height checks before manual rendering.
2. Compare actual mixed exchanges at 30/300/3,000 turns, including GFM tables, nested lists, fences, citations, attachments and tool expansion. Measure preparation, Markdown parsing, layout, memory and p95 frame time separately. No universal pixel-exact claim from plain paragraphs.
3. Seed intrinsic sizes and verify prepend anchor displacement, sidebar resize, turn navigation and pinned streaming. Proposed budget: at most 2px anchor displacement after correction, and no lost selection or focus. Capture remembered-size behavior across width changes.
4. Test native composer sizing plus overlay with empty/placeholder/final-newline/IME/paste, expanded mode and middle-of-draft caret edits; verify draft restoration and attachments remain unaffected.
5. Run sustained unique streaming content and session switching to demonstrate bounded retained metrics and preparation budget. Keep the existing narrow subscriptions and host event coalescing.

Executed source checks: upstream `bun test` passed 204 tests/1,211 assertions; package build and dry pack passed. The full upstream browser suite was inspected, not rerun. Its tracked dashboard reports 7,680/7,680 on each browser, but its maintained gate explicitly preserves known failures and does not assert universal equivalence. See `tests/wrapping/README.md`, `VALIDATION.md`, `PLATFORM_BUGS.md` and `status/dashboard.json` in the pinned clone.

Mako `npm run lint` exited 0. ESLint reported two existing `react-hooks/incompatible-library` warnings in file-tree.tsx and search-view.tsx. Its anti-slop stage exited successfully with no diagnostics. These existing warnings were left unchanged under the read-only instruction.

Coordination note: the main task later reported concurrent viewport movement. This investigation did not set a viewport override. No further browser interaction was performed after that instruction. Rerun the page under exclusive main-owned CUA control before treating timing numbers as comparable performance evidence. The saved run records matching start/end viewport dimensions but has no continuous guard against intermediate changes.

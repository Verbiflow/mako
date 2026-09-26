# Mako visual library pilot

Read-only evaluation, 7 September 2026. No Mako source edits. External clones, dependency installs, scripts, tests and visual studies are isolated in `/tmp/mako-ui-pilot-visual/audit-lKCiR5IO/`. Mako had pre-existing uncommitted changes, including composer, stage and control preview work. This audit inspected the current working files, not only HEAD.

**Recommendation:** build the pilot around an ambitious opening composition, optional Fonttrio reading typography, and one useful usage chart. Prefer custom adaptations of selected registry sources. The strongest visual direction is the editorial welcome inside Mako's existing workbench, with the dither landscape as an alternate appearance. Preserve ordinary text, draft ownership, provider neutrality and narrow subscriptions. These are experiments with named departures from existing style rules, not reasons to reject the libraries.

## Evidence and deliverables

| Repository | Audited commit | Source root in this audit |
|---|---|---|
| [Dither Kit](https://github.com/Boring-Software-Inc/dither-kit/tree/1e7faee9aa252e499651e6736ed65f7a07d9a6bd) | `1e7faee9aa252e499651e6736ed65f7a07d9a6bd` | `dither-kit/registry/dither-kit/` |
| [Fonttrio](https://github.com/KapishDima/fonttrio/tree/8af7098ada0b90f076fbfe260244d11b05dd2403) | `8af7098ada0b90f076fbfe260244d11b05dd2403` | `fonttrio/registry/fonts/`, `fonttrio/registry/pairings/` |
| [Spell UI](https://github.com/xxtomm/spell-ui/tree/fffe96db7b67b44243bf35815916fdfc58fe5014) | `fffe96db7b67b44243bf35815916fdfc58fe5014` | `spell-ui/registry/spell-ui/` |

Pins match the user's `docs/public-audits/2026-09-07/ui-library-pilot/sources.json`. Mako HEAD at inspection was `a5bde7b76cdc0eb30fa1abf42eacb15456ab73f1`; local edits mean its current source is not fully described by that commit.

- Runnable comparison: http://127.0.0.1:8767/visual/index.html
- Offline entry: `visual/index.html`, with sibling `visual/assets/`.
- Three labeled custom HTML/CSS studies: workbench, editorial, dither. No React library components are mounted. Actual locally served Instrument Serif, Instrument Sans and Geist WOFF2 assets; licenses accompany each asset. Charts, book and halftone terrain are custom mocks. All tasks and usage are fictional.
- `make-visual.py` regenerates the page and custom static terrain. Its dependency paths are local to this audit.
- `registry-inventory.json` records all Dither/Spell registry entries, declared dependencies, exact files and imports.
- `probe/audit.mjs` reproduces the bundle measurements; `probe/package-lock.json` records dependency resolution. `bundle-sizes.json` holds raw results.
- `dither-tests.log` records the complete upstream test run.

To copy the report, copy this file. To retain the runnable studies, also copy `visual/`. If moving the HTML elsewhere, adjust its `../REPORT.md` link or keep that layout. The server is loopback-only and serves this isolated audit directory. Restart with `python3 -m http.server 8767 --bind 127.0.0.1 --directory /tmp/mako-ui-pilot-visual/audit-lKCiR5IO`.

## Distribution, runtime dependencies and licenses

All three root projects are private packages. Do not treat their root `package.json` as the installation footprint of a copied component.

| Candidate | Actual consumption | Runtime dependencies of relevant items | License evidence |
|---|---|---|---|
| Dither Kit | shadcn-style source registry; `@dither-kit/cli` is an installer, not a chart runtime | Chart core declares `motion`, `d3-scale`, `d3-shape`, `clsx`, `tailwind-merge`. React and Tailwind are prerequisites. Standalone gradient/avatar/button need the shared pixel/palette/lib files and only `clsx`, `tailwind-merge` beyond React. | Root/package metadata declares MIT; no LICENSE file found in pinned repository. Record the declaration, but obtain the actual copyright/license notice before shipping copied source. |
| Fonttrio | Font recipes and `registry:style` pairings; font packages/assets, not the website | Selected font assets and scoped CSS. No need for Next, Jotai, GSAP, OGL, analytics or MCP SDK for typography. | Repository `LICENSE` is MIT. Font licenses are separate. The actual Instrument assets installed for the sketch include SIL OFL 1.1 notices. Do not infer every font's rights from the repository MIT license. |
| Spell UI | Individual source files from `registry.json`, 33 entries | Chart, tilt, perspective-book have no declared extra engine. `cn` imports still need the consumer's utility. Blur/words/checkbox need Motion; Copy needs Lucide; rays need Three; animated-gradient imports `next-themes` although its registry dependencies are empty. | `LICENSE` is MIT, copyright 2025 Spell UI. Retain it with adapted source. Separate asset licenses remain relevant, e.g. do not assume the site's Lastoria OTF is covered by the component license. |

Mako already has React 19, Tailwind 4, Radix, `clsx`, `tailwind-merge`, `lucide-react` and `next-themes`. Its root does not declare Motion, D3 or Three. Spell's Next/MDX/auth/database/Whop/analytics dependencies belong to the demo/application, not the Chart or checkbox. Fonttrio's GSAP/Inertia DotGrid is a website component at `components/DotGrid.tsx`, not a font registry payload. It continuously paints a canvas and is unnecessary for font adoption.

Useful direct source anchors:

- [Dither registry and runtime dependency declarations](https://github.com/Boring-Software-Inc/dither-kit/blob/1e7faee9aa252e499651e6736ed65f7a07d9a6bd/registry.json)
- [Spell registry declarations](https://github.com/xxtomm/spell-ui/blob/fffe96db7b67b44243bf35815916fdfc58fe5014/registry.json)
- [Fonttrio Instrument pairing](https://github.com/KapishDima/fonttrio/blob/8af7098ada0b90f076fbfe260244d11b05dd2403/registry/pairings/instrument-serif-instrument-sans.json)

## Dither Kit: concrete opportunities and exact motion behavior

Nine registry entries cover core, area/line/Sparkline, grouped/stacked bars, pie/donut, radar, avatar, button, gradient and the aggregate installation. `area-chart.tsx`, `bar-chart.tsx`, `pie-chart.tsx`, `radar-chart.tsx` expose composable children. `scales.ts` uses D3 scale/stack geometry. This is **Canvas 2D plus SVG/DOM overlays**, not Recharts and not WebGL. `dither-paint.ts` defines a 4×4 Bayer matrix, 2 CSS-pixel cells and backing caps of 520×200. Bloom is a blurred, additively composited second canvas. It is not a GPU shader engine despite the glow terminology in comments.

Best targets: daily cost bars, input/output/cache composition, a single expanded usage chart; static gradient for opening art; deterministic avatar texture as optional workspace identity. Radar should wait for real commensurable metrics, not invented provider quality scores. Dither source colors are palette enums/raw RGB; adapt them to values resolved from Mako tokens in `src/index.css`.

### Idle behavior, not just animation flags

Source: [cartesian-canvas.tsx](https://github.com/Boring-Software-Inc/dither-kit/blob/1e7faee9aa252e499651e6736ed65f7a07d9a6bd/registry/dither-kit/cartesian-canvas.tsx), especially lines 63–65, 118, 190–221 and 265; `bar-canvas.tsx:141`, `pie-canvas.tsx:132`, `radar-canvas.tsx:157`; `dither-paint.ts:176`.

- Every chart family's draw callback schedules the next RAF before checking readiness or dirty state. Idle mounted charts therefore retain scheduled callbacks. Browsers may suspend RAF for a hidden document, but these components do not explicitly manage document visibility or offscreen/covered panes.
- Area/line caches expensive fill work. In normal motion, `winkDue` becomes true about every 100ms, so stars continue updating even after the entrance ends. A present hover/controlled marker also keeps the visible redraw path active each frame. The base dither fill is not recomputed every idle frame; distinguish callback activity, compositing and fill work.
- Bar/pie/radar skip paint when `needsFill` is false, but still execute their RAF callbacks. Enabled bloom copies the crisp canvas each frame before the dirty early return. Area's bloom does the same.
- `animate={false}` disables entrance progression; it does not stop the loop. Sparkline defaults to `animate=false` and `interactive=false`, but wraps AreaChart and inherits this machinery.
- Each canvas samples `prefersReducedMotion()` when its effect/loop starts. There is no media-query change subscription. Reduced motion disables entrances, snaps geometry easing and makes area stars steady, but leaves RAF scheduling intact. Area hover intensity still uses factor `0.16` even in reduced mode; bar uses `reduce ? 1 : 0.16`. A visible marker and bloom can still cause ongoing work in reduced mode.
- `gradient.tsx` is different: it paints on mount, prop change and ResizeObserver, with 960×600 backing caps. No continuous animation loop. `aria-hidden` and `pointer-events-none` make it appropriate for decoration. Large resize-driven paints still deserve measurement.

### Proposed custom renderer adaptation

Retain geometry and Bayer appearance; replace the always-running driver with invalidation-based scheduling. Give the mounted chart one pending RAF handle. Data revision, dimensions, token palette, selected series, marker, hover and motion preference changes mark it dirty and request at most one frame. Draw latest state, cache static fill separately, and copy bloom only when its source or configuration changes. Continue requesting frames only while an entrance or hover transition is unsettled. At rest, schedule nothing.

Remove ambient winks in ordinary usage views. If the pilot explicitly wants winks, allow a bounded opening-only sequence while visible, then stop. A stationary marker is static paint, not grounds for another frame. Subscribe to the reduced-motion media query; snap on change, cancel pending animation, repaint once. Pause on hidden document, offscreen chart, and stage coverage. Mako deliberately keeps covered workbench content mounted, so CSS hiding alone must not be the scheduler's lifecycle contract. Resume with one invalidation. Cleanup cancels RAF and disconnects observers/listeners.

Do not funnel pointer samples through React state if only the crosshair paint changes. Keep semantic selected values synchronized at deliberate selection boundaries. Downsample before creating per-row geometry, retaining extrema and exact tooltip/table data. Rendering 520 columns does not itself bound upstream input processing.

### Accessibility and data meaning

`cartesian-root.tsx:177` exposes a generic `aria-label="Chart"`; scrubbing is pointer-driven. `legend.tsx` uses real buttons and focus handlers, but selection needs an explicit announced state. Provide a descriptive figure caption, keyboard selection of date/series, pressed states, and a table/details equivalent. Texture cannot be the only series distinction. Use solid outlines and textual values. Do not equate absent pricing with zero: `scales.ts` maps non-finite/non-numeric input to zero, so missing-price handling must happen at the chart boundary.

## Fonttrio: welcome and reading-mode experiments

The clone contains 1,926 font JSON records and 393 pairing JSON files, including the `popular/` directory. This is a file count, not a claim of 393 distinct deduplicated pairings. `registry/fonts/*.json` carries Google family/provider/import/weights/subsets metadata. `registry/pairings/*.json` references three fonts and emits typography CSS. `lib/registry.ts` builds the index; `lib/hooks/font-load-registry.ts` loads remote Google stylesheet URLs for the website. Use local font assets in Electron instead of importing that loader.

| Experiment | Exact recipe/source | Adaptation and purpose |
|---|---|---|
| Editorial welcome | `registry/pairings/instrument-serif-instrument-sans.json`; `registry/fonts/instrument-serif.json`, `instrument-sans.json` | Instrument Serif 400 at display size for welcome only, Instrument Sans for optional short editorial prose. Keep Geist rail/settings/composer and system mono. The recipe asks for heading weights 700/600 although Instrument Serif metadata supplies only 400; override to real 400 to avoid synthesized bold. |
| Reading mode | `registry/pairings/syne-newsreader.json` | Newsreader for completed answer prose, Syne for optional welcome/reading headings. Keep live composer, shell and code unchanged. Test body at 15–16px, line-height about 1.6, 65–75ch width. This is an explicit opt-in experiment beyond the current 14px prose token. |
| Expressive alternative | `registry/pairings/fraunces-instrument-sans.json`; `registry/fonts/fraunces.json` | Fraunces welcome headings, Instrument Sans prose. Compare variable-axis rendering and weight at actual sizes. Load only the chosen family/assets, not every available weight or pairing. |

Pairings install `@layer base` rules for `h1`, `h2`, `h3`, `h4,h5,h6`, `body,p`, and `code,pre`, plus font theme variables. Verbatim installation changes the entire application and code font. Copy selected font assets and scope the typography to welcome/reading containers; explicitly preserve inline and block code. Define tokens in `src/index.css`. Use dedicated welcome/reading font variables rather than rebinding shell `--font-sans` or code `--font-mono`.

Acceptance matters more than font fashion: compare 11/13px shell legibility separately from prose; inspect punctuation, `Il1/O0`, long paths, italics, bold, mixed CJK/Latin fallback, ligatures and selection. In a long transcript, switching fonts must preserve scroll anchor and draft/focus state. Avoid changing metrics mid-stream; activate the chosen font before presenting reading mode or preserve the current anchor after loading. Load selected subsets locally, `font-display:swap`, no remote font request; measure actual layout shift. Fonttrio's license does not certify accessibility or every font asset license.

The editorial HTML sketch deliberately tests a broader Instrument Sans UI and paper palette to make the contrast visible. The first implementation recommendation is narrower: welcome/prose scope with Geist shell. Both remain legitimate pilot comparisons, not a demand to migrate the whole application.

## Spell UI: borrow selectively

Paths below are relative to `spell-ui/registry/spell-ui/`.

| Component | Engine/dependencies | Finding and recommendation |
|---|---|---|
| `chart.tsx` | Plain SVG, custom rounded path, React, consumer `cn`; no D3/Recharts/Motion | Best simple usage trend baseline. ResizeObserver and memoized geometry, pointer hover, no perpetual RAF. Mouse-only interaction and no meaningful chart/table accessibility contract. Domain uses data min/max rather than zero; choose an honest cost domain. Large arrays need bounds; `Math.min(...data)` is not a big-data strategy. Adapt tokens, keyboard/pointer access and semantic values. |
| `animated-gradient.tsx` | Raw WebGL2; imports `next-themes`, missing from registry dependency declaration | Strong optional hero experiment without Three. Continuous RAF, uncapped devicePixelRatio, rebuild on params changes; cleanup deletes GPU resources. Requires no-motion/static fallback, visibility pause, DPR cap, shader compile/link checks, context-loss handling. Scope to empty welcome and stop after arrival. A static CSS/rendered image alternative is valid. |
| `light-rays.tsx` | Three.js `WebGLRenderer`, `ShaderMaterial` and plane | Attractive cinematic welcome candidate, but larger dependency. Uses DPR=1, high-performance preference and preserveDrawingBuffer. `animation.animate=false` freezes time but still renders and schedules RAF. Initial dimensions are set once; no resize listener/observer found. Cleanup disposes renderer/geometry/material. Prefer static capture/custom shader or fix lifecycle and resizing in an isolated optional chunk. |
| `blur-reveal.tsx`, `words-stagger.tsx` | Motion | Welcome headline only. BlurReveal provides an sr-only whole string and hidden visual glyphs, a useful accessibility detail. It generates per-character elements and has no component-level reduced-motion handling. Shorten to a single 150–220ms reveal or use whole-word CSS; never wrap streaming answers this way. |
| `tilt-card.tsx`, `perspective-book.tsx` | CSS transforms; TiltCard changes React state on pointer move | Good appearance samples and unopened document covers. Reduce tilt to 2–4°, scale to 1, equivalent focus affordance. Open previews must be flat and sharp. Preserve pixel accuracy for screenshots/diffs and text selection. |
| `animated-checkbox.tsx` | Motion | Clickable div without native checkbox semantics, keyboard handling or controlled value. Recreate the visual check on Mako's existing controlled checkbox rather than copying its behavior. |
| `label-input.tsx` | Lucide, native input | Visual floating label has no `htmlFor` association. Keep existing Mako form semantics, explicit IDs/labels and error descriptions; retain only the treatment if useful. |
| `copy-button.tsx` | Lucide | Calls clipboard write, suppresses rejection, immediately sets copied=true, including when value is absent. Adapt visual check transition only. Await the actual copy result, show failure, permit retry, cancel timer on unmount. Copy still belongs to the whole exchange answer in Mako. |
| `exploding-input.tsx` | DOM particles and RAF; no declared library engine | Finds an `input` inside closest label; Mako uses a textarea. Input events spawn particles, measuring text and creating DOM nodes. Continuous particle loop is not a send acknowledgement. A custom short accepted-send flourish outside the textarea is the better experiment; no particles on each keystroke. |
| `fallback-avatar.tsx`, `signature.tsx`, `kbd.tsx` | Avatar canvas loop; signature Motion + opentype.js; kbd react-hotkeys-hook | Lower priority. Static workspace identity is cheaper; signatures add font parsing for little task value. Render shortcut labels from Mako's command registry, do not install a parallel hotkey system. |

The proposed shader lifecycle repairs and accessibility fixes have not been implemented here. No measured GPU/FPS claims are made.

## Measured bundle probe

Executed `node /tmp/mako-ui-pilot-visual/audit-lKCiR5IO/probe/audit.mjs`. esbuild browser ESM, minification + gzip; React/ReactDOM external; dependencies bundled; no CSS. Each entry is independent. Shared `cn`/tailwind-merge contributes substantial common bytes. These are **not incremental Mako bundle costs**, and a lightweight custom gradient without that helper can be smaller.

| Entry | Minified bytes | Gzip bytes |
|---|---:|---:|
| Dither AreaChart | 63,962 | 23,536 |
| Dither Gradient | 30,280 | 10,031 |
| Dither Sparkline | 65,822 | 24,196 |
| Spell Chart | 32,771 | 10,976 |
| Spell Rays | 502,744 | 130,808 |
| Spell AnimatedGradient | 11,438 | 4,443 |

Probe versions include React/ReactDOM 19.2.6, Motion 12.38.0, D3 scale 4.0.2 / shape 3.2.0, Three 0.181.2, next-themes 0.4.6. Dependencies are in `probe/package-lock.json`. The initial probe install using React 19.2.3 failed peer resolution because npm selected a newer ReactDOM; pinning both to 19.2.6 resolved it. No forced/legacy peer bypass was used. Native app cold-start, memory, GPU power and streaming performance remain acceptance work.

## Mako integration map

All paths below are under `/Users/kashyab/pi-ui/` and describe future integration, not edits made in this audit.

| Area | Current integration point | Pilot proposal and invariants |
|---|---|---|
| Opening | `src/components/transcript/transcript.tsx:49` EmptyTranscript; `src/components/transcript/launcher.tsx`; `src/extend/slots.ts` transcript.empty | Redesign welcome around one of the three compositions. The slot currently sits inside a 460px content block after the title; it cannot replace the whole composition without changing EmptyTranscript. Preserve actual first-run provider/workspace steps and suggestion-fill behavior. Never auto-send. |
| Usage | `src/components/settings/usage-section.tsx`; `src/state/usage.ts` | Replace tiny daily bars with an accessible detailed chart. Keep reported vs estimated cost, API-equivalent wording, coverage, unknown pricing and scan truncation. Optional wide companion registers through `src/desk/builtins.tsx` / `registerSurface`, rather than a second layout system. |
| Composer | `src/components/composer/composer.tsx`; `context-dial.tsx`; `src/state/drafts.ts`; composer.controls/trailing/above slots | Keep one stable textarea and draft key. Custom accepted-send feedback may decorate the action button. Context uses explicit exact/reported/unavailable states, not fabricated precision. No GPU/shader or per-letter animation subscriber on the token path. |
| Settings | `src/components/settings/appearance-section.tsx`; `settings-dialog.tsx`; `src/state/prefs.ts` | Add opt-in welcome/reading appearance samples inside existing Radix dialog. Keep controlled inputs and focus trap. Scope fonts and tokens; any keyboard action goes through commands. Do not replace settings semantics with Spell demo controls. |
| Rail | `src/components/rail/thread-row.tsx`; `agent-threads.tsx`; `session-rail.tsx` | Static texture for workspace identity, one selection treatment, narrow status subscriptions. Keep bounded folder pagination and 80-result search cap found in current code. Do not put Dither Sparkline or animated avatar on every row. |
| Previews | `src/components/inspector/control-preview-panel.tsx`; `src/components/viewer/file-view.tsx`; `tabular-preview.tsx` | Flat screenshot/file content. Book/tilt only for unopened covers or appearance samples. CSV chart is opt-in after column/type selection, retaining table, truncation disclosure and source values. Current control panel distinguishes observed frames and activity and watches while mounted. |
| Layout/state | `src/components/stage/stage.tsx`; `src/desk/builtins.tsx`; `src/index.css` | Keep fixed draggable sidebar/dock, workbench mounted under covering sidebar, no shadows on shell, token definitions centralized. New decorative work must pause when covered. No new provider list, bridge import, transcript renderer or host protocol. |

## Acceptance tests for the pilot

These are proposed gates, not claims already passed by the static sketches.

1. **Visible ambition with readable work.** Compare three compositions at 1280×800 and a narrow 900px window, plus 200% text zoom. Title may be expressive; composer, provider/workspace selection, setup and first action must remain visible and usable. Inspect both light/dark and high-contrast/forced-color fallback. Target 4.5:1 ordinary text and 3:1 large text/control boundaries. No texture over readable code or screenshots.
2. **Actual chart idle proof.** Instrument RAF callbacks, fill paints and bloom copies separately. After transitions settle, zero component-scheduled frames for five seconds, including a stationary marker, bloom enabled, reduced motion, stage covered and document hidden. Data change triggers one coalesced repaint; resize/motion preference change updates correctly. Unmount leaves no RAF/listener/observer. This directly tests the proposed repair, not just an animate prop.
3. **Chart truth and access.** Test no data, all zero, one day, missing prices, outliers, sub-cent values and long labels. Unknown stays unknown; totals reconcile with UsageSummary. Every pointer-selected value is reachable with keyboard or equivalent table. Legends expose state; pattern/color changes cannot hide which series is selected.
4. **Streaming preservation.** Use real host/native threads without `?mock` for normal verification. Replay a long response while typing and changing selection. A token does not wake rail, usage or welcome art; reconciliation preserves old message identity. Profile before/after. Proposed budget: less than 5% regression in p95 input/streaming frame work on the same machine; no new >50ms long task attributable to the pilot. Do not call the threshold measured until profiled.
5. **Draft safety.** IME composition, pending attachment, refused send, provider change, late failure and session switching preserve the latest paragraph. The send flourish starts only on acceptance and cannot reset/remount the textarea. Copy rejection must not display success; successful copy includes the entire answer.
6. **Reading typography.** Test completed long answers, prose/code mixture, 200% zoom, fallback languages and offline startup. Toggle reading mode at a deep scroll position without losing the anchor. Shell stays Geist, code stays platform mono. No synthesized Instrument Serif 600/700, no external Google font request, no invisible text during loading.
7. **GPU experiment.** Resize to/from a covering sidebar, disconnect/recover WebGL context, deny WebGL, change reduced motion at runtime. Static fallback stays legible. Cap backing DPR; pause offscreen and end bounded welcome animation. Measure actual GPU/process memory and idle CPU before preferring a shader over static art.
8. **Host and quality boundaries.** No component/desk bridge imports, provider switches or replacement command listeners. Run `npm run lint` including zero-warning/error `lint:anti-slop` for any future source changes, relevant performance/draft/usage tests, and real UI verification. No rule disabling to ingest external source.

## Tests actually run and limits

Inside the isolated Dither Kit clone:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm test
```

**Passed, exit 0.** Vitest 2.1.9: 3 files, 28 tests passed. Breakdown: palette 4, scales 16, chart-mount 8. CLI Node tests: 27 passed, 0 failed/skipped/cancelled. Full output: `dither-tests.log`. Installation created a local npm lockfile; upstream uses bun.lock, so this run reflects the resolved npm dependency set recorded in the clone's package-lock.json, not an exact frozen Bun install.

The mount tests use happy-dom and mocked dimensions. They cover mount stability/context identity without React Compiler, not real canvas fidelity, idle energy, chart keyboard operation or GPU performance. The passing suite does not invalidate the RAF findings. No extra Mako tests/lint were run because this task changed no Mako source. No Mako host was launched or agent prompt sent.

The HTML comparison was served successfully and opened through CUA. Its accessible document exposes all three compositions, source labels and textarea controls. Main reviewed the saved visual studies through CUA at desktop width 1280 and compact width 534 and reported that both rendered well. These sketches demonstrate composition and actual font assets, not production component parity or implementation completion.

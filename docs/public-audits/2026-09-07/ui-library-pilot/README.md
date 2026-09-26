# Mako: aggressive UI library pilot

Source investigation and isolated experiments, 7 September 2026.

Recommendation: pursue a coordinated pilot across all nine repositories. Use Pretext as a layout engine with Mako-owned block geometry, build one hybrid sound engine from Cuelume recipes and selected Soundcn assets, expand Sonner's operation feedback, compare Slot Text with complete-label motion, and prototype adaptive panels with both Vaul and existing Radix. Give Dither Kit, Fonttrio and Spell UI concrete roles in an expressive opening screen and richer Usage view.

The first assessment was too conservative for a product with no users. This pass inspected actual source at pinned commits, compared published packages with repository HEAD where relevant, ran tests and targeted probes, measured browser layout and bundle sizes, and built three visual studies plus a working label comparison. It does not claim these libraries are integrated into Mako or that synthetic measurements prove an application speedup.

## Open the experiments

- [Three visual studies](visual/studies/index.html): workbench, editorial typography, and dither. These are custom HTML/CSS sketches with real local fonts. They deliberately explore departures from the current type scale and palette. Charts, book, terrain, tasks and usage are illustrative, not production library components or real data.
- [Pretext benchmark](pretext/standalone.html): actual pinned Pretext code, embedded Geist font, browser height comparisons and diagnostic timings. Click Run benchmark. No Mako data or provider execution.
- [Label comparison](motion/labels.html): actual Slot Text versus custom complete-label transitions. Includes rapid interruption. It does not touch the clipboard.

The HTML artifacts can be opened locally. To browse the complete collection, run from the repository root:

```sh
python3 -m http.server 4190 --bind 127.0.0.1 --directory docs/public-audits/2026-09-07/ui-library-pilot
```

Open `/visual/studies/`, `/motion/labels.html`, or `/pretext/standalone.html`. The generic static server does not persist benchmark results, but the benchmark displays JSON and provides a download. `node docs/public-audits/2026-09-07/ui-library-pilot/pretext/serve.mjs` instead serves the benchmark at port 43917 and saves results. Stop any earlier benchmark server before reusing that port. Embedded library/font licenses accompany the experiments.

## What I would build

| Repository | Aggressive pilot | What Mako should own |
| --- | --- | --- |
| [Pretext](https://github.com/chenglou/pretext/tree/8460bf940c50d82be90a396fb0ea2c4e7a2dc6f3) | Width-aware transcript geometry, better offscreen height estimates, stable history prepend/resize, richer turn previews. | Block layout from the same Markdown parse tree as rendering; bounded prepared-text/height caches; measured correction for complex blocks; incremental invalidation. Consider a fork for incremental preparation if the adapter proves valuable. |
| [Cuelume](https://github.com/Danilaa1/cuelume/tree/b879b72c01f3b3fa74c45c9b20bbd064baffb282) | Tactile synthesized cues for accepted actions, toggles and state changes. | Adapt selected MIT recipes into a shared engine. Its public API cannot inject a context, stop active voices or dispose the engine. |
| [Soundcn](https://github.com/KapishDima/soundcn/tree/7cbfbb3f56e8548b81fb26410bdcea657447d087) | Distinctive completion and attention sounds, selectable in an audition panel alongside synthesis. | Curated assets, provenance, gain normalization, shared decoding/voice lifecycle, mute/stop and event dedup. Use it together with Cuelume sound design, without retaining two engines. |
| [Slot Text](https://github.com/Danilaa1/slot-text/tree/209795b60a195013e79849abc809ad0d576e2d75) | Copy feedback, commit-message generation, connecting/stopping labels. Compare word rolls with a custom complete-label transition. | Font-aware stable space, interruption, one accessible label, reduced-motion selection, timers and successful-outcome ownership. Generic text rolls and finite state pairs need not use the same implementation. |
| [Sonner](https://github.com/emilkowalski/sonner/tree/8e4662b39255120b62138312058f5d77c0139a5e) | One evolving notification per operation, useful Retry/Open actions, aggregated background outcomes. | Stable operation IDs and original workspace context, truthful success, persistent actionable failures, Mako timing/type tokens, command-registry integration. Keep the existing package. |
| [Vaul](https://github.com/emilkowalski/vaul/tree/3e97aac6a38e4481bade71d7233ed6002e80f9b0) | Handle-dismissable Changes/Context/History covers when the stage narrows; compare with custom Radix side-sheet. | Patch or pin the actual behavior under test, interruption, keyboard resizing, focus return, fixed preferred widths and persistent mounted content. Unmaintained status means ownership, not automatic rejection. |
| [Dither Kit](https://github.com/Boring-Software-Inc/dither-kit/tree/1e7faee9aa252e499651e6736ed65f7a07d9a6bd) | A textured welcome, optional workspace identity, daily-cost bars and detailed usage charts. | Token palette conversion, demand-driven chart painting, keyboard/table equivalents, missing-price handling. Its standalone gradient already paints on invalidation rather than looping. |
| [Fonttrio](https://github.com/KapishDima/fonttrio/tree/8af7098ada0b90f076fbfe260244d11b05dd2403) | Instrument Serif welcome, Newsreader reading mode, and a Fraunces alternative. Compare actual fonts rather than dismissing typography changes. | Scoped typography recipes and local font assets; real available weights; font/Pretext cache invalidation and scroll preservation. Current shell/code typography can coexist with these experiments. |
| [Spell UI](https://github.com/xxtomm/spell-ui/tree/fffe96db7b67b44243bf35815916fdfc58fe5014) | Gradient/short reveal at welcome, tactile checks/buttons, document covers, SVG usage-chart comparison, accepted-send flourish. | Native control semantics, truthful copy feedback, no-motion/static fallbacks, visibility/resource lifecycle and Mako tokens. Copy the visual idea where the source behavior is incomplete. |

## Pretext: substantial adoption, with the right workload

The main task reran the benchmark under exclusive browser control. Environment recorded by the page: Chromium 152, DPR 2, 1280 x 720, visible/focused, Geist loaded, matching start/end viewport. The detailed Pretext report retains the earlier investigator run; the saved `pretext/results.json` and figures below are the later main-task run.

| Diagnostic | Main-task result |
| --- | ---: |
| Paragraph line counts | 65/66 match |
| Corrected Pretext textarea adapter, within 1px | 78/80 |
| Native CSS field-sizing versus current textarea height method, within 1px | 80/80 |
| Cold preparation, 500 paragraphs, median of seven | 101.40 ms |
| Cached layout, normalized per 500 paragraphs | 0.641 ms |
| Batched DOM width writes then height reads, 500 paragraphs | 3.50 ms |
| Interleaved DOM writes/reads, 500 paragraphs | 59.20 ms |
| Full preparation for 120 growing prefixes, ending at 24,800 characters | 1,282.70 ms total |
| DOM text assignment and height read for those prefixes | 99.90 ms total |

Cached numeric relayout was about 5.5 times faster than the batched DOM diagnostic. This excludes preparation, DOM creation, paint and Markdown parsing. Font/JIT caches were warm even when Pretext caches were cleared. The later plain-paragraph cache example shares warm segment caches and repeated text, so it is not a controlled speedup result. No end-to-end Mako latency improvement has been measured.

The paragraph mismatch is a long Geist identifier at width 360: 95 actual lines, 94 predicted. The two textarea misses occur in the 14px stress configuration; current 13px fixtures passed. These are useful regression witnesses, not reasons to abandon the engine. Keep predictions correctable and avoid treating a height match as proof of exact caret or line-break geometry.

The highest-value first integration is replacing `.contain-turn`'s generic `auto 120px` estimate in `src/index.css:359` with a prepared, width-specific estimate. Keep `auto` remembered dimensions and observed correction. Test width changes because updating the fallback does not necessarily invalidate the browser's remembered size. Prepare nearby or newly loaded history within a bounded budget rather than synchronously preparing the full catalog.

Derive geometry from the same remark/GFM/citation tree used for DOM rendering. Use Pretext for prose and styled inline runs; compose margins/indents/chrome explicitly. Keep observed geometry for tables, attachments and expanded tools. Cache by stable content identity plus font/style signature; cache layout by width separately. Reconciliation must continue protecting unchanged messages. An append may invalidate earlier Markdown nodes, so never assume arbitrary blank-line splitting is safe.

A custom incremental-preparation fork is worth a second experiment: reuse proven unchanged blocks and reanalyze the affected paragraph with its shaping, whitespace and bidi context. The current API has no append operation. Do not simply concatenate prepared arrays. A worker is a later option only after font parity and emoji calibration are addressed.

For the composer, compare native `field-sizing: content` first. It avoids Mako's current `height=0; scrollHeight` autogrow cycle and won the height-fidelity experiment. It still needs real textarea/mention-overlay, caret, IME, paste, placeholder and draft-restoration verification. Pretext remains the larger transcript opportunity.

## Custom work that earns its cost

**One audio engine.** Source-execution probes reproduced duplicate decoding for concurrent requests, overlapping sample playback surviving hook unmount, and closed-context reuse. Cuelume also retains the pre-resume volume for a pending request. Use one context, a real master gain, bounded voice/cache ownership and a generation counter to invalidate pending work. Drive toast, sound and visual attention from the same successful action or fresh lifecycle event. Historical hydration and stale external activity are not completion events. Where reliable reconnect dedup needs a run identity, add it at the provider-neutral boundary rather than inventing success from snapshots.

**One panel controller.** The published Vaul 1.1.2 differs materially from HEAD, including modal forwarding. Its 500ms motion is coupled to JavaScript timers, so overriding CSS alone is insufficient. Compare patched Vaul with an existing-Radix implementation that owns only desktop handle dragging, snap-back and focus. Keep the registered content mounted through presentation changes, preserve the independent Terminal dock, and allow keyboard/close-button alternatives. This is a prototype decision, not a claim Vaul is unusable.

**A chart scheduler.** Dither charts keep RAF callbacks alive even after entrances and in reduced motion. Expensive fill painting is partly cached, so do not equate every callback with a full redraw. Replace continuous scheduling with invalidation from data, size, palette and interaction; stop when settled or covered. Preserve geometry and the dither visual treatment. Keep a semantic table and exact cost/coverage values.

**Behavior-preserving visual controls.** Spell's checkbox lacks native checkbox behavior and its copy button suppresses failure while showing success. Recreate those treatments on Mako's controlled controls and domain actions. Keep Sonner's existing machinery while making focused failure actions persistent. Slot Text offers useful generic rolls; a fixed label pair can be smaller and smoother with two complete text layers.

## Three visual directions

The studies deliberately make the differences visible. They show a returning workspace's empty task, not an unconfigured first launch. Actual first-run setup must remain part of the implemented design.

1. Working desk: strong task hierarchy, immediate composer and optional usage companion. Best structural baseline.
2. Working edition: Instrument Serif and a paper palette. Best typography experiment; begin by scoping it to welcome and optional completed-answer reading mode.
3. Signal room: a dither landscape and textured usage. Strongest visual identity experiment. Keep the terrain behind the empty state and remove it when the conversation begins.

My preferred pilot combines the working desk's task structure with the signal room's opening identity, then offers the editorial treatment as a reading/appearance alternative. Give the opening one short arrival, let input respond immediately, and put meaningful motion into accepted actions and panel transitions. The current 15px-only heading rule should not preclude testing a display title in these explicitly labeled studies.

## Measurements and checks

Independent minified browser bundles with React/ReactDOM external, transitive imports included, CSS excluded: Dither area chart 23,536 gzip bytes; Dither gradient 10,031; Spell SVG chart 10,976; Spell WebGL gradient 4,443; Spell Three-based rays 130,808. These are not additive or incremental Mako bundle costs. Registry website dependencies are not component dependencies. See the visual report for method and locked probe dependencies.

- Pretext: 204 upstream tests passed, 1,211 assertions; package build passed. Full upstream browser suite was not rerun.
- Slot Text: 35 tests across three files passed; typecheck and build passed. Main verified copy-state and burst controls in its isolated browser comparison.
- Cuelume: six tests passed. Silent fake-Web-Audio probes reproduced the lifecycle cases. No listening test or actual speaker/headphone audition was performed.
- Soundcn: all 813 sample modules measured and hashed, 805 distinct payloads; five candidates decoded numerically. Selected original Kenney-pack licensing was checked. Positive float peaks in two samples warrant headroom; they are not browser true-peak or listening measurements.
- Dither Kit: 28 unit/mount tests plus 27 CLI tests passed. This does not certify real canvas rendering or idle behavior.
- Sonner and Vaul published consumer APIs typechecked with React 19/TypeScript 6. Sonner operation/focus probes ran in happy-dom; full Sonner/Vaul browser suites were not run.
- Three visual compositions inspected through CUA at desktop and compact widths. They demonstrate custom composition and actual font assets, not integrated Mako functionality.
- `npm run lint`: exit 0, no errors, two existing TanStack/React Compiler ESLint warnings. Anti-slop emitted no warnings/errors. No application source or dependencies were changed by this investigation.

## Implementation order and proof

Build the visual/interaction pilot and geometry pilot in parallel, then combine them for a real-host verification pass.

1. Opening composition, scoped font candidates, Dither gradient/static render and adapted Spell treatments. Preserve provider/workspace setup and suggestion-fill behavior.
2. Shared semantic feedback, corrected copy outcome, Slot Text comparison and Sonner operation lifecycle. Add hybrid audio audition and event mapping on that same ownership.
3. Pretext block-geometry cache and intrinsic-size hints, plus native composer sizing comparison. Use current renderer and correct observed sizes.
4. Vaul versus custom Radix adaptive panel, then Dither versus Spell SVG Usage chart with exact values and idle scheduling.
5. Run combined typing, long-history prepend, sidebar resize, live streaming, font switching, reconnect, reduced-motion and unmount tests on real Mako. Keep source-level fixes and their reproductions together.

Acceptance targets, not measured outcomes: no draft/selection loss; no duplicate or historical cues; no pending sound after mute/dispose; no movement under reduced-motion selection; no background decorative RAF after settling; actionable notifications remain focusable; unchanged exchanges/rail do not wake per token; no new pilot-attributable long task above 50ms in the chosen workload. Measure cold preparation, steady-state frame work, memory and chart painting separately. If a choice misses the target, repair or replace that implementation rather than abandoning the visual goal.

## Detailed source evidence

- [Pretext architecture, witness cases and benchmark method](pretext/REPORT.md)
- [Cuelume and Soundcn source, asset and lifecycle audit](audio/REPORT.md)
- [Slot Text, Sonner and Vaul source/package comparison](motion/REPORT.md)
- [Dither Kit, Fonttrio and Spell UI registry/visual audit](visual/REPORT.md)
- [Pinned revisions, manifests, registry/test inventory](sources.json)

`collect.py` regenerates the last inventory from supplied checkout roots without executing package scripts. Probe sources and dependency locks are retained alongside reports; their original checkout paths are documented. Standalone HTML experiments already embed their runtime where noted. The existing working tree had unrelated ongoing changes, so Mako HEAD alone does not reproduce every local source observation.

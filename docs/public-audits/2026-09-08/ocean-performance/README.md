# Ocean animation performance

Measured in Electron against the production OceanScene and SettingsDialog, with a fixture host. No agent prompts are sent. The viewport is 1280 × 768 CSS pixels at 2× density. Each mode records three seconds of animation and twelve Settings opens. The Mac was under heavy memory pressure, so dialog timings are diagnostic rather than a reliable latency guarantee.

| Three-second sample | Original, first / last | Revised, first / last |
| --- | --- | --- |
| Paint events, all motion | 714 / 664 | 0 / 0 |
| Layout events, all motion | 357 / 332 | 0 / 0 |
| Main-thread task time | 411 / 444 ms | 345 / 273 ms |
| Median Settings open to two frames | 26.1 / 24.7 ms | 26.2 / 18.3 ms |

The water's animated mask-position repainted every frame. The fin's animated SVG mask also forced layout. The grain already needed no paints. The revised water moves a static mask and counter-moves its image to keep every engraved line aligned. The fin uses two static SVG masks with a transform and opacity animation scaled to the artwork's cover crop. The water, fin and grain keep their independent periods, alternate easing, pause-on-focus behavior and reduced-motion support.

Run `node scripts/profile-ocean.mjs /tmp/ocean.json` to capture the current version. An optional third argument selects a git revision for the three ocean source files, while retaining working packaged artwork URLs. The profiler uses Chromium timeline Paint and Layout events. The older LayerTree counters in the saved JSON are unsupported by this Electron version and must not be used.

The renderer asset test also decodes the fin's CSS masks under both HTTP and file URLs. The browser UI fixture checks alignment, independent movement, loop boundaries and lifecycle pauses.

Desktop verification: the installed `/Applications/Mako.app` uses the optimized renderer with the previous working host. A full package of the concurrently edited workspace exited during startup, so it was not left installed. The original host entry point is byte-identical in the installed archive. The replacement archive's integrity hash and app signature were regenerated and verified. The installed ocean, command palette and Settings were inspected; `desktop.png` records the result.

Validation: build, stage tests, all browser UI regression checks, HTTP/file artwork and mask decoding, and scoped ESLint pass. Full ESLint is blocked by the concurrent Claude SDK change importing `../../mcp-registry.js` from `electron/providers/claude/sdk-options.ts:5`; the rule requires provider modules not to import their consumers. That unrelated migration was not modified for this animation fix.

Final Oxlint anti-slop run exits successfully with zero warnings and errors. The final diff passes whitespace checks.

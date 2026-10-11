# Desk redesign — audit against Superset and OpenCode Desktop

August 2026. Sources: `ignore/superset` (apps/desktop + packages/ui), `ignore/opencode`
(packages/desktop → packages/app, packages/ui v2, packages/session-ui), and a full
inventory of our own `src/`. Every claim below was verified against the actual reference
code; file paths refer to those checkouts.

The one-sentence diagnosis: **our bones are fine, our surface system is the weak layer.**
Both reference apps get their "clean" look from the same three decisions — a two-level
surface architecture (dark chrome, floating light content), interaction state expressed as
translucent overlays of a single token, and a tiny type scale — none of which we have.
Meanwhile we spend our depth budget on glass blur and radial washes, which is exactly the
kind of decoration both of these apps refuse.

---

## 1. What makes OpenCode look the way it does

The load-bearing idea is the **deep shell / floating card** architecture:

- The window chrome (titlebar, tab strip) sits on `bg-deep` — `#080808` dark, `#fafafa` light.
- The content region is a **card**: `m-2 rounded-[10px] bg-base` with an elevation shadow,
  floating on that deeper shell (`packages/app/src/pages/home.tsx:19-22`). `bg-base` is
  `#161616` dark / `#ffffff` light — always one step *lighter than the chrome* in dark and
  *lighter than the chrome* in light too (white on off-white). Content floats; chrome recedes.
  The relationship is identical in both modes, which is why the app reads the same in both.
- Above `bg-base` there are exactly three more layers (`layer-01/02/03`: `#242424`,
  `#2e2e2e`, `#3a3a3a` dark) used for menus, bubbles, and selection — always stepping
  *away* from content toward chrome.

Everything else hangs off that:

- **Hairlines are 0.5px, alpha, drawn as `box-shadow: inset 0 0 0 0.5px`** — never `border`,
  never an opaque grey (`theme.css:291-295`, used everywhere).
- **Every elevation token bakes the hairline in** as its last layer, and dark mode adds a
  `0 -0.5px 0 alpha-light-6` top rim light — surfaces catch light from above like real
  material (`v2/styles/theme.css:114-136`, `:475-497`).
- **Hover/press are overlay tokens** (`overlay-hover` = 4-6% alpha, `overlay-pressed` =
  8-10%), stacked as gradient layers over any base color (`button-v2.css:75-84`). One pair
  of tokens replaces every per-surface hover color.
- **Three text sizes**: 11 (meta, +0.05px tracking), 13 (everything, −0.04px), 15 (section
  titles, −0.13px). Three weights off Inter's variable axis: 440 body, 530 titles/buttons,
  640 settings headers. Prose is the one exception at 14/160%.
- **Two motion curves total**: `cubic-bezier(0.22,1,0.36,1)` for layout, `cubic-bezier(0.2,0,0,1)`
  for toasts; everything else plain ease-out, 85–280ms. Tooltip exits faster than entries.
- Only the **user** message gets a bubble (right-aligned, `max-width: min(82%, 64ch)`,
  layer-02, radius 10, no border). Assistant is full-width, no chrome
  (`message-part.css:1-160`).
- Tool calls are **rows, not cards**: one 20px line `title · subtitle · args · diff ± · chevron`,
  separated by color only; expanded body indents behind a hairline (`basic-tool-v2.css`).
- The tool-status label ("Reading foo.ts…" → "Read foo.ts") crossfades inside one grid cell
  while the container springs its width — blur resolves at 0.8× the fade so it reads as one
  object changing (`tool-status-title.css:18-76`).
- Settings is a **980×600 dialog** with a 240px vertical tab rail (two groups + version
  stamp footer) and list-cards: `radius 8`, `bg-layer-01`, inset 0.5px hairline, rows with
  20px block padding divided by 0.5px rules (`settings-v2.css`).
- No user identity UI at all; the avatar vocabulary is **project identity** — 16px fixed-color
  monograms with a cut-out unread notch (a radial-gradient mask carves a hole so the accent
  dot separates over any background, `project-avatar-v2.css:107-122`).
- No sidebar and no status bar. The titlebar has three portal mounts (left/center/right) and
  *is* the status surface.

## 2. What makes Superset look the way it does

- **Warm near-black ramp** ("Ember"): `#151110 → #1a1716 → #201E1C → #252220 → #2a2827`,
  foreground `#eae8e6`. The radical bit: `border`, `input`, `muted`, `secondary`, and
  `accent` are **one hex** (`#2a2827`). Separation comes from area, not from a border color.
- **Foreground-derived interaction fills** — the single best idea in the codebase:
  `--fill-hover: color-mix(in oklab, var(--foreground) 7%, transparent)` and
  `--fill-selected: … 10%` (4%/6% light). Selection is a tint of the *text* color, never the
  brand, and it survives any user-imported theme (`globals.css:58-60`).
- One accent (ember orange `#e07850`) that appears in chrome exactly once — a PRO badge that
  tints on hover. `primary` is the foreground, so buttons are light-on-dark, not orange.
- **The sidebar is always recessed**: darker than content in light mode, lighter than
  content in dark mode.
- **No shadows on chrome** — only popover/dialog/tooltip get them. Steps + 1px borders do
  everything else.
- **Inverted zero-shift tab chrome**: active tab is outlined on three sides, open-bottomed,
  flowing into content; inactive tabs carry the bar's baseline as their bottom border. All
  states keep a 1px border on all four sides, so switching never shifts a pixel
  (`TabItem.tsx:117-131`).
- **Settings search is an index**: typing filters the nav itself with per-section match
  counts, auto-navigates to the first section with hits, highlights matches inline
  (`settings/layout.tsx:125-145`).
- **Identity is org-first, in the sidebar footer**: avatar + org name + plan badge, opening
  a menu with members / switch org / help / log out (`OrganizationDropdown.tsx`).
- Hover affordances **reserve layout** (`invisible` → `visible`, never `hidden`), so rows
  don't reflow; tooltip delay is tuned per surface (1000ms on always-visible chrome, 300ms
  on hover-revealed actions).
- Drag regions live **only on empty leaf spacers**, never containers (documented rule,
  `TopBar.tsx:57-60`) — carve-outs under a drag ancestor die inside zoomed/masked subtrees.
- The empty state is a **launcher**: wordmark over a column of ghost action rows with their
  shortcuts as keycap chips.

## 3. Where we stand (honest audit)

The desk already does several things both references do: achromatic ramp, no shadow-for-
elevation, hairline discipline, sentence-case labels, single accent-as-light. But:

1. **Our depth model is decoration, not architecture.** `app-wash` (three radial gradients:
   cool key, warm ember, violet drift) + `panel-glass`/`surface-glass` (28px backdrop blur,
   5-layer shadows) is the opposite of both references, which are flat, opaque, and get
   depth from surface steps. Glass is also why our panels never feel "settled" — content
   and chrome share one luminance world instead of two.
2. **The transcript doesn't float.** Rail, transcript, preview, and inspector are four
   columns of nearly the same value separated by hairlines. There is no figure/ground.
3. **The type scale is not a scale**: 14 distinct literal px sizes (73× `text-[10.5px]`,
   56× `11.5px`, 52× `10px`, 49× `12px`, 41× `11px`, 35× `12.5px`, …), none tokenized;
   `10px` vs `10.5px` used interchangeably for the same role.
4. **Hover/selection state is per-site**: `bg-raised` ×96 alongside `/50 /60 /70 /90` alpha
   variants picked ad hoc. No overlay tokens.
5. **16 sites bypass the semantic status colors** with raw `emerald-400`/`red-400`/
   `amber-300` (settings, composer, acp-panel, plugins) while `--positive/--negative/
   --caution` sit unused next to them. Two incompatible usage-bar threshold palettes.
6. **The kit is half-adopted**: `PanelHeader` and `Meter` have zero consumers; every panel
   header and progress bar is hand-rolled; three keycap chip implementations; four content
   measures (760 / 672 / 544 / 736px); four empty-state patterns and two loading vocabularies.
7. **Identity is dead state.** `github.ts` fetches and caches an avatar no component renders.
   `PullRequestCard` renders `null` when GitHub isn't connected — the one place a "connect"
   affordance belongs has nothing. Provider accounts are letter monograms buried in settings.
8. **Settings nav labels don't match their section headings** ("Providers & accounts" →
   "Agents", etc.), and quota bars appear in two visual languages in two sections.

---

## 4. The redesign

### 4.1 Surface architecture — deep shell, floating stage (the big move)

Adopt OpenCode's two-level model, keeping our achromatic ramp:

```css
/* dark */
--shell:    oklch(0.115 0 0);   /* titlebar, tab strip, rail, inspector chrome */
--stage:    oklch(0.165 0 0);   /* the floating content card */
--layer-1:  oklch(0.205 0 0);   /* popovers, menus, user bubble, settings cards */
--layer-2:  oklch(0.245 0 0);   /* chips, active tab base, inputs */
--layer-3:  oklch(0.30 0 0);    /* selected rows, keycaps */

/* light */
--shell:    oklch(0.955 0 0);
--stage:    oklch(1 0 0);
--layer-1:  oklch(0.975 0 0);
--layer-2:  oklch(0.945 0 0);
--layer-3:  oklch(0.915 0 0);
```

- The **transcript + composer become one card**: `m-2 rounded-[10px] bg-stage` with an
  elevation token, floating on the shell. The rail and inspector live on the shell —
  recessed chrome, Superset-style.
- **Delete** `app-wash`, `panel-glass`, `surface-glass`, `transcript-field`, `lit-edge`,
  `prompt-card`, `raised-card`, and the `data-glass` pref. Depth budget goes to the card.
- **Elevation tokens with the hairline baked in**, dark gets the rim light:

```css
--elevation-raised:   0 2px 4px oklch(0 0 0/4%), 0 1px 2px -1px oklch(0 0 0/8%),
                      0 0 0 0.5px var(--hairline);
--elevation-floating: 0 8px 16px oklch(0 0 0/…), 0 4px 8px …, 0 0 0 0.5px var(--hairline);
/* dark additionally: 0 -0.5px 0 0 oklch(1 0 0/6%) */
```

- **Hairlines go to 0.5px inset box-shadow**, alpha-derived, everywhere a `border-hairline`
  exists today.

### 4.2 Interaction state — two tokens, foreground-derived (Superset's trick)

```css
--fill-hover:    color-mix(in oklab, var(--foreground) 6%, transparent);
--fill-selected: color-mix(in oklab, var(--foreground) 10%, transparent);
/* light: 4% / 7% */
```

Every `hover:bg-raised`, `bg-raised/60`, `bg-raised/70`, active-row, and active-tab state in
the app collapses onto these two. Selection stays a tint of the text color, never the brand
— consistent with our "accent is light" rule, and it makes future themes free.

### 4.3 Type scale — three sizes, tokenized

```
--text-meta:  11px / 12px,  +0.05px tracking   (timestamps, counts, keycaps, eyebrows)
--text-ui:    12.5px / 18px, −0.03px           (rows, buttons, menus, tabs, inputs)
--text-title: 15px / 20px,  −0.13px            (dialog + settings section titles)
prose stays 13.5/1.65 (mako-prose), code 12px mono
```

Migrate all 14 literal sizes onto these four. `10/10.5/11/11.5` → meta; `12/12.5/13` → ui.
Weights: 440/530/640 off Geist's variable axis instead of normal/medium/semibold — the
half-weights are a large part of why OpenCode reads "expensive". Tabular-nums on anything
counting.

### 4.4 Shell & chrome

- **Titlebar stays 38px but becomes the status surface.** Right cluster gains the identity
  item (below) and absorbs the context/cost readings as compact labelled chips
  (`141K/400K · $6.62`) with popover detail. **The 22px status bar is deleted** — neither
  reference has one; branch/workspace move to the rail header and composer context line.
- **Tabs adopt Superset's zero-shift inverted chrome**: active tab outlined three sides and
  open-bottomed into the stage; inactive tabs carry the baseline. Keep our dot states.
- **Drag-region discipline**: `drag-region` only on empty leaf spacers (we already hit this
  bug — the sort popover wouldn't dismiss because titlebar clicks never reach the DOM; the
  CSS suspension now in `index.css` treats the symptom, leaf spacers fix the cause).
- Navigate on `mousedown` for tabs and rail rows (`event.detail === 0` guards keyboard).

### 4.5 Left rail

- Sits on `--shell`, no glass. Rows 28px, `rounded-[6px]`, `mx-2` gutters; selection =
  `fill-selected`; hover actions use `invisible → visible` so rows never reflow.
- **Harness marks become fixed-color mini-avatars** (16px, radius 4, monogram or mark, the
  provider tint as a *background* at low chroma) with OpenCode's **cut-out unread notch**
  for "activity since you looked" — the mask carves a hole so the dot reads over any row
  state. Running = the dot pulses; unread = static.
- Folder rows steal Superset's icon-slot morph: folder glyph swaps to chevron on hover, no
  permanent disclosure column.
- **Rail footer becomes the identity row** (Superset): GitHub avatar + name + plan/usage
  glance, opening the account menu. This is where "who am I" lives when the rail is open.
- Empty rail becomes a launcher, not a sentence: three ghost action rows (Open a folder ⌘O,
  New session ⌘N, Search ⌘⇧F) with keycap chips.

### 4.6 Chat

- Prompt card → **user bubble**: right-aligned, `max-width: min(82%, 64ch)`, `bg-layer-1`,
  radius 10, no ring. Unmistakably the user's without the full-width slab. Assistant stays
  full-width, chrome-free.
- Tool rows are close already; adopt the **tri-state leading glyph** (spinner → icon →
  chevron in one slot) and the **crossfade + width-spring status label** for
  running→done transitions (tokenized `--tool-motion-*`, 480ms easeOutQuint).
- Streaming text gets the **negative-delay shimmer** (every char mid-animation on frame
  one) instead of our linear `.shimmer` sweep.
- Scroll fades on the transcript switch to **scroll-driven animations** (binary
  `animation-range: 0 0.1px` visibility test) — no JS, no scroll listeners.

### 4.7 Inspector

- Chrome on `--shell` like the rail; panels read as part of the stage card or as a second
  card (prototype both; the second card matches OpenCode's review pane).
- Tabs move to the inverted-chrome treatment shared with the tab strip.
- Adopt the **fixed-minimum split rule**: reserve a fixed minimum for the inspector and give
  the remainder to the chat, instead of a percentage that grows the inspector on big
  monitors (`session-panel-width.ts:1-12` states the rationale).
- Everything hand-rolled goes through the kit: one `PanelHeader`, one `Meter`, one `Keys`.

### 4.8 Identity & GitHub (the missing feature)

Two surfaces, one source of truth:

1. **Titlebar-right avatar** (20px, rounded-full; falls back to a monogram). We already
   fetch the GitHub avatar in `packages/host/src/git/github.ts` and cache it in `state/github.ts` — it
   is currently rendered nowhere. Clicking opens the account menu: GitHub identity row
   (name, login, "signed in via gh"), then provider accounts (Claude Code / Codex rows with
   the usage bars from settings), Switch/Capture account, separator, Settings ⌘,.
2. **Rail footer row** shows the same identity when the rail is open (avatar + name + plan
   chip that tints on hover, Superset-style).

When GitHub isn't connected, both render a quiet "Connect GitHub" affordance — replacing
today's `return null` in `pull-request.tsx`, which hides the feature exactly from the
people who haven't set it up.

### 4.9 Settings

Keep the full-window route (it fits ten sections better than a dialog) but rebuild it:

- **Frame darker than content** (shell outside, stage inside, Superset's `bg-tertiary` →
  `bg-background` move).
- Nav at 224px with **grouped sections**: *Personal* (Appearance, Notifications), *Agents*
  (Providers & accounts, Models, MCP, Plugins), *Workspace* (Git & PRs, Conversation,
  Automations), *System* (Usage, Updates, Troubleshoot) — and nav labels that match their
  section headings exactly.
- **Search-as-index**: filter the nav with per-section match counts, jump to first hit,
  highlight matches inline. This is the single biggest usability lift in settings.
- Rows become **list-cards**: `radius 8`, `bg-layer-1`, inset 0.5px hairline, 20px-block
  rows divided by 0.5px rules. Kill the local `Toggle`/`Segmented` and move them into the
  kit; one usage-bar component with one threshold palette (`--caution` >72%, `--negative`
  >90%) for both settings and the composer.
- Version stamp in the nav footer.

### 4.10 Motion

Two curves, one table (replacing our four eases + ad-hoc durations):

| duration | use |
|---|---|
| 90ms ease-out | switches, presses |
| 120ms ease-out | menus in, row hover, chevrons; 80ms ease-in out |
| 150ms ease-out | hover-reveals, pills |
| 240ms cubic-bezier(0.22,1,0.36,1) | panel widths, drawers |
| 480ms cubic-bezier(0.22,1,0.36,1) | tool-status label spring |

`interpolate-size: allow-keywords` on `:root` lets collapsibles animate `height: auto` and
retires the grid-rows trick in the rail.

### 4.11 Hygiene (do first — it's the cheap 30%)

1. Replace all 16 raw `emerald/red/amber` sites with `--positive/--negative/--caution`.
2. One `Keys` chip; delete the raw `<kbd>` styles in first-run and guide.
3. One empty-state primitive (`Blank`, extended with an action slot) for rail, palette,
   settings, file tree (loading ≠ empty), and PR card.
4. One loading vocabulary: `.skeleton` sweep; delete the rail's hand-rolled pulse bars.
5. One content measure (760px) for settings/guide/palette bodies where feasible.
6. Delete dead tokens (`--rail-width`, `--inspector-width`), dead prefs (`railGroupBy`,
   `railDensity`), and wire up or remove `github.avatar`.

---

## 5. Sequencing

1. **Hygiene pass** (4.11) — zero visual risk, shrinks the surface the redesign touches.
2. **Token swap** (4.1–4.3): new ramp, overlay fills, elevation, type tokens. One PR that
   changes `index.css` + mechanical class migration; the app looks ~the same but flatter.
3. **The card** (4.1): float the transcript+composer, recess rail/inspector, delete glass.
   This is the visible "drastic" moment.
4. **Chrome** (4.4–4.5): tabs, titlebar-as-status, delete status bar, rail restyle.
5. **Identity** (4.8) — new feature, independent of the rest.
6. **Settings** (4.9) and **chat/motion polish** (4.6, 4.10) in parallel.

Deviations from AGENTS.md to bless before starting: the status bar is a product-surface
change (its numbers move to titlebar + composer), and `.pressable`/token names in
`index.css` get renamed, not removed. The achromatic-ramp and light-accent rules are kept —
both references validate them; OpenCode's blue accent is the one thing we deliberately
don't take.

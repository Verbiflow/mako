# Mako's design system

One brand, one set of primitives. Everything on screen is built from what's below; a new surface uses these rather
than its own. `src/index.css` holds the tokens and nothing else does. `npm run lint` enforces what a rule can check
(eslint for classes, `scripts/check-design-tokens.mjs` for stylesheets); the rest is review.

## Tone

- **Surfaces are tones, not boxes.** Chrome is `--shell`; a pane's body is `--surface`; anything raised above it
  (a prompt, a row's selection, a card) is `--raised` or a tint of the text colour (`--fill-hover`,
  `--fill-selected`). Sections part by tone and spacing, never a hairline, and nothing has an outline for its own
  sake. Hairlines (`--hairline`) stay for content (a diff's file header, a table) and an input's focus. One pane alone has no
  frame; of two side by side, the focused one is framed.
- **Shadows only float.** Menus, the palette, dialogs and toasts (`--elevation-*`) cast one, and the composer, which
  floats over the transcript (`--elevation-composer`, a tone up and never outlined); nothing else in a pane does.
- **The ramp is warm neutrals**, quiet in both themes. Hue appears only where it means something.

## Colour

| Token | Means | Never |
| --- | --- | --- |
| `--sea` | The brand's one accent (the fin's lit face, hue 245): the open Thread's lit fin, the glint on a working fin (`--fin-glint`), the caret, the composer's send once there's something to send (its glyph `--on-sea`) | links, borders, focus, hover, icons at rest, any other fill bigger than a badge; two in one pane |
| `--attention` | Waits on the person: needs you, an ask, an approval, the pip, the ask's edge | warnings |
| `--caution` | A warning: risky access, a limit near, a step that went wrong but can go on | needs you, "changed", decoration |
| `--negative` / `--positive` | Failed, removed / done, added | anything else |
| Text | `--foreground`, `--muted-foreground`, `--faint` | |

No literal colour in a component or a rule; no orange, no gold, no "ember" (the accent until November 2026). A
harness's or provider's mark draws in one ink inside the app's own chrome (`tinted={false}`); its brand tint is
for a picker that chooses it.

## Shape

- **Every corner is square**, as the fin is. The radius tokens are all 0 and radius classes are refused. Only what
  means a dot is round (`rounded-full`): a status dot, the unread sphere, a switch's knob, a sheet's grab handle.
- **Type**: `text-label` (12), `text-ui` (14), `text-title` (16), prose (16), code (12); weights 440/530/640 through
  `font-normal`/`font-medium`/`font-semibold`. Sentence case, no letterspacing, no uppercase labels. Every number
  carries its noun.
- **Icons**: lucide, at 14px (`size-3.5`) beside UI text and 12px (`size-3`) beside a label, the default stroke.
  One icon one meaning: Copy, Edit (`PencilLine`), Rewind (`Undo2`), never two circular arrows side by side.
  A file's or folder's mark is the one exception: its kind's own (`components/ui/file-icon.tsx`, by name and
  extension in `lib/file-kinds.ts`), at the same sizes, one stroke on one grid, square joins, told apart by shape or a
  language's letters and never by hue.

## Who and how: the fin

`LiveMark` (`src/components/ui/live-mark.tsx`) is the mark of every Thread and Fin: the two-tone fin for a Thread,
the plain fin for a Fin, the harness a small square badge in the corner, drawn in one ink. The fin itself says how it
stands:

- working: a glint of `--fin-glint` crosses the fin, and it bobs (thinking), glides (writing) or braces (a tool);
- needs you: the fin in `--attention` over a breathing waterline;
- asking its Apex: it drifts, dimmed; queued: faint; idle and open elsewhere: still, dimmed; failed: it lists over
  in `--negative`; an answer to read: the unread sphere.

No spinner beside a name, no ring, no comet, no separate line beside the fin. Wherever a Thread or a Fin is named
(a row, a tab, a chip, a routed line, a message's avatar) it wears this mark, still where its state isn't the point
(`StillMark`, `AgentAvatar`). A harness's logo as the main icon is for choosing a harness, nothing else.

## Components

Use these; don't redraw them.

| Need | Use |
| --- | --- |
| A button | `Action`, `IconAction` (`ui/kit.tsx`), with `pressable` |
| A small fact | `Chip` |
| A switch | `Toggle` |
| Something to read or act on above the composer | `Notice` (`ui/notice.tsx`), on the composer box's own edges: whatever stands over it (notices, the queue, a goal, a plan) is its width, on every form |
| A menu, a popover, a dialog | `ui/menu.tsx`, `ui/popover.tsx`, `ui/dialog.tsx` |
| A tooltip | `ui/tooltip.tsx`, or `title` naming the action ("Send", "Copy") |
| Loading | `Skeleton` for a shape to come, `Shimmer` for words at work, `Spinner` only inside a control that waits |
| A list of an Apex's Fins | the Shiver card (`viewer/shiver-card.tsx`): needs you, working, queued, failed; done and idle folded. A row's time is how long the Fin has stood as it does (`since`): a working one's current turn, never its age |
| A row of a rail's fixed top | `RailRow` (`rail/rail-row.tsx`): the left rail's New thread and Inbox, the right rail's Changes and Files |
| A message | `Prompt` and `FinReports` (`transcript/`), the avatar beside the message's last line |
| The composer | the same in every view and on every client (`composer-frame.tsx`; the web app's `web-client/composer.tsx` draws the same box, its controls a finger's size on a phone or an iPad): in the transcript's column, one square box a tone up from the pane (`--raised`), floated by a soft shadow and never outlined, its fill lifting a breath while typing, the draft, then one row of plus, harness and model with its reasoning, send; under the box a quiet status line of where and how the work runs (this Mac or the cloud, the folder or branch, the access level in words, `--caution` only for full access) and the context reading at its end |

## The rails and tabs

The window is two rails on the shell and the conversation between them, the one pane on `--surface`. The right rail is
the left's twin: `SideRail`'s rows, one a surface in a fixed order, each with a quiet reading at its end (`+141 −246`,
`2 need you` in `--attention`), and what a row opens under them. Agents shows only while there's someone to show:
no Fins and nothing running, no row. Changes is a list; what's read at length opens as a tab.

A tab is what someone opened on purpose: a file, a diff, a plan, a Session, the one Fin opened in place. Nothing gets a
tab by starting. An Apex's Fins stand in the Shiver card and the rail; opened, a Fin gets one tab, and closing it is the
Apex again. The phone's the same: a count in the bar and the Shiver card, no chip a Fin.

## Words

- No hint lines that explain the interface ("To the Apex · it passes it on…"); the placeholder or the menu that's
  asked for says it.
- Placeholders say the action in a few words: "Ask anything", "Steer Claude · ⌘↩ queues", "Message Dictation".
  An idle composer reads "Ask anything" in a new Thread and an existing one alike: the model chip already names who
  answers, so a placeholder names the harness only when the send does something particular with it (steers, queues,
  moves the conversation, starts a session beside the others).
- Counts of Fins are the roster's one vocabulary (`rollupLine`, `rollupChip`, `rollupLabel`).

## Motion

`transform` and `opacity` only, on HTML boxes, on the shared clock, resting off screen and under reduced motion
(`observeVisibleAnimation`, `observePhaseLockedAnimation`). Two curves: `--ease-out` to arrive, `--ease-swift` to
leave; entrances under 250ms, presses `scale(0.97)`, nothing from `scale(0)`. An endless loop runs only on the gate;
Tailwind's `animate-*` loops are refused.

One set of durations, in `index.css` and read by script through `src/lib/motion.ts`: `--duration-press` (120),
`--duration-tooltip` (120, out 80), `--duration-menu` (160, out 120) for menus, popovers and rows or cards arriving,
`--duration-switch` (140) for one view of a place giving way to another (`.animate-switch`, a fade), and
`--duration-panel` (240, out 200) for a sidebar. A spring only where a finger hands off its speed
(`src/web-client/motion.ts`). Nothing moves on the first paint or for a change nobody asked for (a launch restoring a
sidebar, another tab bringing its own), and what a key repeats many times a minute (the palette, walking a list)
doesn't animate; a sidebar's toggle does, by key or by click.

A sidebar slides by `transform` beside a pane laid out once at its new width (`side-slide.ts`): the pane's edge and the
parts marked `data-slide-anchor` glide from where they were, so the transcript reflows and measures once, not every
frame. A toggle mid-way turns around from where everything is drawn.

## State

A view keeps what it last showed through any transition of its session: a turn, starting, waking, reconnecting,
failing, resting. A transition is a quiet status line, never content vanishing (`npm run test:fin-view-keeps-ui`).

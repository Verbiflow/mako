---
name: mako
description: How to modify Mako itself — the desktop app you are running inside. Covers the codebase layout, which edits appear live without a restart and which do not, and the design and performance rules the codebase holds itself to. Use whenever the task is to change Mako's own interface or behaviour.
---

# Modifying Mako

You are running inside Mako, and this session is pointed at Mako's own source.
Edits you make here change the window you are being read in.

## Two ways to change this app

**Decide which one you are doing before you start.** They have different reach
and very different feedback loops.

### 1. A trusted local UI extension — works in every build, applies with no reload

Write one `.tsx` file into the extensions directory. Mako compiles it in the
renderer, runs it with full renderer-state access, and repaints its contributions
immediately. Use this only for trusted local presentation, commands, and transcript
renderers. Provider transports, accounts, MCP/skills, persistence, and host tools
belong in source under `packages/host/src/harnesses/`; UI extensions cannot add them.

The directory is `<userData>/plugins/` — on macOS,
`~/Library/Application Support/mako/plugins/`. Write there with your ordinary
file tools; you do not need to tell Mako anything.

```tsx
export function setup(mako) {
  mako.registerCommand({
    id: "clear-branch",
    title: "Copy the branch name",
    section: "Extension",
    run: () => navigator.clipboard.writeText(mako.session.read().git?.branch ?? ""),
  })

  mako.registerSlot("rail.footer", () => {
    const branch = mako.session.use((s) => s.git?.branch)
    return <span>{branch}</span>
  })
}
```

What `mako` gives you: `apiVersion`, `registerCommand`, `registerCommands`,
`registerSlot`, `registerToolView`, `registerSurface`, `runCommand`, `session`,
`threads`, `prefs`, `toast`, and `React`.

Four rules:

- **Trusted code only.** Extensions execute inside Mako's renderer with access
  to its state. They are bounded, but not sandboxed or suitable for third-party
  code.
- **No imports.** There is no bundler in the loop. Everything you may use is on
  `mako`; a bare `import` of a package will fail.
- **Types are stripped, not checked.** Write TypeScript if you like, but nothing
  verifies it.
- **`registerSlot` needs a declared slot name.** The list is in
  `src/extend/slots.ts`. A seam that is not in that map does not exist.

### 2. Editing the source — only visible when running from a checkout

If Mako is running from source with a dev server, an edit to `src/**` is hot
replaced and a component swaps in place. If it is a packaged build, **nothing
you edit in `src/` or `electron/` can be seen at all** — there is no source tree
in the bundle. Check which situation you are in before promising a result.

Even from a checkout, `electron/**` is the main process: it needs a rebuild and
a full app restart. Say so plainly whenever you touch it, and finish the
renderer-side work first so there is something to look at.

One trap when editing source: a module that exports a React component *and*
something else (a constant, a hook) falls back to a full reload instead of a
component swap. Keep component files exporting components.

## Layout

```
electron/          main process — needs a restart
  main.ts          window, IPC handlers, app lifecycle
  host.ts          one agent, hosted: `AgentHost` owns a single runtime, cwd,
                   and git root. All agent I/O goes through here. Today it
                   wraps Pi, but nothing above this file knows that — keep
                   agent-specific assumptions inside it.
  pool.ts          the open tabs: several `AgentHost`s at once, one in front.
                   Commands address the foreground tab; the rest keep running.
  providers/       one vertical module per external harness: native/ACP runs,
                   profile, session emission, accounts, MCP, and skills
  ipc/             domain-owned request registration; `main.ts` only composes it
  automation.ts    a loopback eval endpoint for checking the UI, dev + opt-in
  automations.ts   saved prompts and their triggers; off until switched on
  crash.ts         local-only crash reports, plus the IPC breadcrumb trail
  github.ts        pull requests and checks, through the `gh` CLI
  updates.ts       the update feed; downloads on its own, never installs itself
  shared.ts        the wire contract between main and renderer
  preload.ts       the contextBridge surface
src/
  components/
    shell/         title bar, status bar, the app frame
    rail/          the session sidebar
    transcript/    the conversation — exchanges, tool rows, markdown
    composer/      the input, model/effort pickers, mentions, attachments
    inspector/     the right panel — changes, context, history, review notes
    viewer/        the open file, over the conversation column
    palette/       ⌘K
    ui/            the shared kit; `kit.tsx` is the primitives
  state/           stores — `session.ts` is the tab in front, `tabs.ts` is the
                   strip plus a cache of every background conversation,
                   `viewer.ts` is the open file
  lib/             pure helpers; no React, no IPC
  extend/          UI extension registries (commands, slots, tool views)
  desk/            command definitions and app-level wiring
```

Two rules the structure depends on:

- `src/lib/` is pure. No React, no IPC, no DOM. If you need a helper for a
  component, it goes here only if it would still make sense in a test.
- Everything the desk ships is registered through the same API in
  `src/extend/` that a local UI extension uses. Add commands and surfaces
  through those registries rather than privileged component branches.

## Design rules

These are not preferences. Breaking them is what makes the app look generated.

**Colour.** One achromatic ramp. Hue appears *only* where it carries meaning —
diff added/removed, error, caution. There is no brand colour; the accent is
lightness, not hue. Never introduce a coloured accent, a gradient wash, or a
purple anything.

**Type.** Geist for the interface, the platform monospace for code. The scale
is in `src/index.css`. No all-caps micro-labels with letterspacing — that is
the single clearest tell of a generated interface, and it costs legibility at
these sizes for nothing.

**Elevation** is a step on the ramp, not a shadow. `background` → `surface` →
`raised`. Shadows are reserved for things that genuinely float (popovers, the
composer card).

**Density.** This is an instrument, not a landing page. Prefer one line over
two. If a row can carry its meaning in one line, it must.

**Copy.** Sentence case. Say what the thing does, not that it exists. Empty
states say what this is, why it is empty, and how to start. Error messages say
what happened and what to do about it. Cut every word that is not doing work.

## Motion rules

Motion is judged by how often it is seen.

- **100+ times a day** (⌘K, keyboard-driven anything): no animation at all. The
  command palette is deliberately unanimated; do not "improve" it.
- **Occasional** (thread switch, modal, toast): 150–250ms, `--ease-out`.
- Never `ease-in` on UI. It delays the first frame, which is the frame the eye
  is on.
- Never animate from `scale(0)`. Start at `0.95` with opacity — nothing in the
  real world appears from nothing.
- Popovers scale from their trigger, not their centre. The Radix
  `--radix-*-transform-origin` variable is already wired for this.
- Only `transform` and `opacity`. Anything else costs layout every frame, and
  this window is often animating while tokens stream.

The curves and durations are tokens in `src/index.css` (`--ease-out`,
`--duration-press`, …). Use them; do not invent new ones inline.

## Performance rules

Streaming is the constraint everything else bends around. A token arrives every
few milliseconds and must cost one turn's re-render, not the window's. More
than one conversation streams at a time, so "cheap per token" is now also
"cheap per *hidden* conversation".

- Subscribe through selectors (`useSession((s) => s.thing)`), never to the whole
  store. Subscribing to `meta` re-renders on every token-count update.
- Message identity is reconciled across host updates so a tool result
  re-renders the one turn that changed instead of re-parsing every turn's
  markdown. Do not replace message objects wholesale.
- Long lists are virtualized. If you add one, virtualize it.
- Offscreen turns are skipped with `content-visibility`. Keep `contain-turn` on
  anything that repeats down the transcript.
- The hot path in `electron/host.ts` sends only the in-flight message and
  coalesces bursts to one flush per frame. Do not add a full-state send to it.
- A backgrounded `AgentHost` sends only `meta`, at 400ms rather than 16ms, and
  hands over everything else in one push when it comes forward. If you add an
  event type, decide which side of that line it belongs on.

## Checking your work

Do not drive the app by synthesising mouse clicks at screen coordinates. It
takes the machine over while it runs — the pointer moves and whoever is using
the computer is locked out — and it is fragile besides: it depends on window
position, on which app is frontmost, and on the click event carrying the right
click-count field.

Launch with `MAKO_AUTOMATION=7333 npm run desktop` and use `scripts/probe.sh`,
which evaluates an expression in the window and prints the result:

```bash
scripts/probe.sh 'document.querySelectorAll("[data-line]").length'
scripts/probe.sh 'const b = [...document.querySelectorAll("button")].find(x => x.textContent === "Save"); b.click(); return "clicked"'
```

Two things it makes possible that clicking cannot: measuring an element, which
is how a control that renders but is 0×0 gets caught; and hovering, by
dispatching pointer events at an element you found rather than at a coordinate
you guessed. Screenshots (`screencapture -l<windowid>`) work on a background
window, so the whole check runs while the machine is in use.

## Working here

- `npm run typecheck` must pass. It runs `tsc -b`, which follows the project
  references — `tsc --noEmit` does not, and silently checked nothing for months.
  Run it before you say you are done.
  It does not cover local UI extensions — those are transpiled, not checked —
  so read an extension back after writing it.
- Match the surrounding code's comment density. Comments here explain *why* a
  decision was made, not what the line does. If a line is obvious, say nothing.
- Make the change the user asked for. If you notice something else wrong,
  mention it — do not fix it silently in the same edit.
- When you finish, say which files changed and whether the user needs to
  restart. A local UI extension is already applied. A source edit is applied only if
  Mako is running from a checkout.

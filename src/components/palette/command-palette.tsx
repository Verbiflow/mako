import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { BotIcon, ChevronRightIcon, FolderIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestIcon, InboxIcon, PlusIcon, SearchIcon, SettingsIcon, SlashIcon, SparklesIcon, TimerIcon, XIcon, ZapIcon } from "lucide-react"
import { Keys } from "@/components/ui/kit"
import { FileIcon } from "@/components/ui/file-icon"
import { LiveMark } from "@/components/ui/live-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { commands, formatChord, keysFor, matchesChord, type DeskCommand } from "@/extend/commands"
import { formatRelative } from "@/lib/format"
import { litRuns } from "@/lib/palette-rank"
import { rank as rankFiles } from "@/lib/fuzzy"
import { asksForProject } from "@/lib/project-query"
import { githubRepository } from "@mako/host/contracts/projects"
import type { FileFindResults } from "@mako/host/contracts/file-index"
import { actions, useCanChooseFolder, useSession } from "@/state/session"
import { prefsStore } from "@/state/prefs"
import { openProjectPalette } from "@/state/open-project"
import { openProjectSettings } from "@/state/project-settings"
import { useWorkspaceFiles } from "@/state/files"
import { workspaceFiles } from "@/state/file-tree"
import { viewer } from "@/state/viewer"
import { search } from "@/state/search"
import { usePullRequestSearch } from "@/state/pull-request-search"
import { memoryBoost, rememberPick } from "@/state/palette-memory"
import { cn } from "@/lib/utils"
import {
  CATEGORIES,
  fieldsOf,
  flatRows,
  PREFIXES,
  searchPalette,
  splitPrefix,
  type GlyphName,
  type PaletteCategory,
  type PaletteIcon,
  type PaletteItem,
  type PaletteRow,
  type PaletteScope,
  type PaletteSection,
} from "@/components/palette/palette-search"
import {
  pullItem,
  useAutomationItems,
  useCatalogItems,
  useCommandItems,
  useModelItems,
  useNeedsItems,
  useProjectItems,
  useSettingsItems,
  type SettingsEntry,
} from "@/components/palette/palette-sources"

/**
 * While the palette is open, every key pressed is the palette's: this listener is on the window's capture phase and
 * added as this module loads, before any component's, so a listener the page underneath holds (Settings' Escape and
 * focus trap, the composer's @ list, an editor's ⌘↩, a view's Escape) never hears a key typed into the palette. A
 * chord another desk command owns still runs it, and closes the palette.
 */
let paletteKeys: ((event: KeyboardEvent) => void) | null = null
globalThis.addEventListener?.("keydown", (event) => paletteKeys?.(event), true)

const PALETTE_COMMAND = "view.command-palette"
const QUICK_OPEN_COMMAND = "view.quick-open"
const MODEL_COMMAND = "model.pick"

/** The desk command a chord runs, if any; what the keyboard layer would run for it. */
function commandFor(event: KeyboardEvent): DeskCommand | undefined {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return undefined
  const overrides = prefsStore.get().keybindings
  return commands.list().find((command) => {
    const keys = keysFor(command, overrides)
    return keys !== undefined && matchesChord(event, keys) && command.when?.() !== false
  })
}

/** What `mako:palette` asked for: a tab, or straight into Switch model. */
interface PaletteRequest {
  category?: PaletteCategory
  scope?: PaletteScope
}

function requestOf(event: Event): PaletteRequest {
  if (!(event instanceof CustomEvent)) return {}
  const detail: unknown = event.detail
  if (!(detail instanceof Object)) return {}
  const category = "category" in detail ? CATEGORIES.find((entry) => entry.id === detail.category)?.id : undefined
  const models = "scope" in detail && detail.scope === "models"
  return { ...(category && { category }), ...(models && { scope: { kind: "models" } as const }) }
}

/**
 * The command palette: one search over everything in the window. Threads and Fins from the whole catalog, what
 * needs the person, projects, pull requests, automations, Settings' sections and the desk's commands, ranked by how
 * well they match (`palette-rank.ts`), how recently they moved and what the person picked before
 * (`palette-memory.ts`), grouped under headers, matched characters lit.
 *
 * A layer over whatever is open (Settings, a dialog, a menu): it's Radix's dialog, so the one beneath keeps its
 * state but gives up focus, the pointer and Escape until this closes, and focus goes back where it was unless what
 * ran put it elsewhere. The caret is in the field on the frame the chord lands; the panel arrives on the menu's
 * motion tokens without delaying it.
 *
 * `threads` replaces the catalog's Threads (the laptop browser's desk lists its own); `settings` loads the window's
 * Settings sections.
 */
export function CommandPalette({ threads: threadsOverride, settings }: { threads?: readonly PaletteItem[]; settings?: () => Promise<readonly SettingsEntry[]> } = {}) {
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<PaletteCategory>("all")
  const [scope, setScope] = useState<PaletteScope>()
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const [now, setNow] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  /** Whether it closed by running something, which then owns focus, or by being dismissed, which gives focus back. */
  const ranRef = useRef(false)
  /** Where focus was when it opened: Radix gives focus back to a dialog's trigger, and the palette has none. */
  const returnRef = useRef<HTMLElement | null>(null)

  const close = useCallback((ran = false) => {
    ranRef.current = ran
    setOpen(false)
  }, [])

  const openRef = useRef({ open, category })
  // Before paint, so a chord pressed the frame after a switch reads the tab it switched to.
  useLayoutEffect(() => {
    openRef.current = { open, category }
  })
  useEffect(() => {
    const show = (event: Event, fallback: PaletteCategory) => {
      const request = requestOf(event)
      const next = request.category ?? fallback
      const held = openRef.current
      // The chord that opened it closes it; another tab's chord switches to it, keeping what's typed.
      if (held.open && held.category === next && !request.scope) {
        close()
        return
      }
      if (!held.open) {
        setQuery("")
        setCursor(0)
        ranRef.current = false
        // Times and recency are read as of the open, so nothing reorders while it's up.
        setNow(Date.now())
        returnRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
      }
      if (request.scope) setQuery("")
      setScope(request.scope)
      setCategory(next)
      setOpen(true)
      inputRef.current?.focus()
    }
    const commandsOpen = (event: Event) => show(event, "all")
    const filesOpen = (event: Event) => show(event, "files")
    window.addEventListener("mako:palette", commandsOpen)
    window.addEventListener("mako:quick-open", filesOpen)
    return () => {
      window.removeEventListener("mako:palette", commandsOpen)
      window.removeEventListener("mako:quick-open", filesOpen)
    }
  }, [close])

  // What's searched trails what's typed when the list is long, so the field never waits on the list.
  const searched = useDeferredValue(query)
  const { prefix, rest } = splitPrefix(searched)
  const term = rest.trim()

  const commandItems = useCommandItems(open)
  const modelItems = useModelItems(open)
  const catalog = useCatalogItems(open && !threadsOverride)
  const needs = useNeedsItems(open)
  const projects = useProjectItems(open)
  const automationRows = useAutomationItems(open)
  const settingsRows = useSettingsItems(open, settings)
  const files = useFileItems(open && category === "files" && !scope, term)
  const pullsWanted = open && !scope && (category === "pulls" || prefix === "#" || (category === "all" && !prefix && term.length >= 2))
  const pulls = usePullRequestSearch(pullsWanted ? term : null, { limit: 30 })
  const pullRows = useMemo(() => (pullsWanted ? pulls.pulls.map((pull) => pullItem(pull, pulls.repository)) : []), [pullsWanted, pulls])

  // Inside a project: start a Thread there, or open its settings, above its Threads.
  const scopeRows = useMemo((): PaletteItem[] => (scope?.kind === "project" ? projectActions(scope) : []), [scope])
  const items = useMemo(
    () => [...scopeRows, ...needs, ...(threadsOverride ?? catalog), ...projects, ...commandItems, ...settingsRows, ...automationRows, ...modelItems, ...pullRows, ...files.items],
    [scopeRows, needs, threadsOverride, catalog, projects, commandItems, settingsRows, automationRows, modelItems, pullRows, files.items]
  )

  const canChooseFolder = useCanChooseFolder()
  const sections = useMemo((): PaletteSection[] => {
    if (now === 0) return []
    const found = searchPalette({ items, query: searched, category, scope, now, boost: memoryBoost })
    const raw = searched.trim()
    // A path or a GitHub address is a project to open: Open project takes it from here, as typed.
    if (canChooseFolder && !scope && category === "all" && asksForProject(raw))
      found.unshift({ group: "projects", label: "Open project", more: 0, rows: [{ item: typedProject(raw) }] })
    // What a title doesn't say, a conversation might: the host's full-text search over every message, last, where
    // the window has it (its Search everything command).
    if (raw.length >= 2 && !prefix && !scope && category === "all" && commands.get("view.search"))
      found.push({ group: "actions", label: "In conversations", more: 0, rows: [{ item: searchConversations(raw) }] })
    // Nothing matched: the words become a new Thread.
    if (!found.some((section) => section.label !== "In conversations") && raw && !prefix && category !== "files" && category !== "pulls" && scope?.kind !== "models")
      found.push({ group: "actions", label: "No matches", more: 0, rows: [{ item: newThreadWith(raw, scope) }] })
    return found
  }, [now, items, searched, category, scope, canChooseFolder, prefix])
  const rows = useMemo(() => flatRows(sections), [sections])

  const [lastSearch, setLastSearch] = useState({ searched, category, scope })
  if (lastSearch.searched !== searched || lastSearch.category !== category || lastSearch.scope !== scope) {
    setLastSearch({ searched, category, scope })
    setCursor(0)
  }
  const at = Math.min(cursor, Math.max(rows.length - 1, 0))
  const active = rows[at]

  const move = (delta: number) => {
    if (!rows.length) return
    const next = (at + delta + rows.length) % rows.length
    setCursor(next)
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" })
  }

  const enterScope = (next: PaletteScope) => {
    setScope(next)
    setQuery("")
  }
  const leaveScope = () => {
    setScope(undefined)
    setQuery("")
  }
  const switchCategory = (delta: number) => {
    const index = CATEGORIES.findIndex((entry) => entry.id === category)
    const next = CATEGORIES[(index + delta + CATEGORIES.length) % CATEGORIES.length]
    if (next) setCategory(next.id)
  }

  const runRow = (row: PaletteRow, alternate: boolean) => {
    const { item } = row
    // Switch model opens its scope rather than closing.
    if (!alternate && item.scope?.kind === "models") {
      enterScope(item.scope)
      return
    }
    rememberPick(item.id, rest)
    close(true)
    if (alternate && item.alternate) item.alternate.run()
    else item.run(rest)
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.isComposing) return
    const command = commandFor(event)
    if (command) {
      // ⌘K closes it, ⌘P switches to Files and ⌘⇧M to models, through their commands; any other closes it and runs.
      if (command.id !== PALETTE_COMMAND && command.id !== QUICK_OPEN_COMMAND && command.id !== MODEL_COMMAND) close(true)
      return
    }
    // Immediate: the composer's @ list listens on the window's capture phase too, after this.
    event.stopImmediatePropagation()
    const input = inputRef.current
    const empty = query === ""
    const caretAtEnd = !input || (input.selectionStart === input.value.length && input.selectionEnd === input.value.length)
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    if (event.key === "Escape") {
      event.preventDefault()
      if (scope) leaveScope()
      else close()
    } else if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault()
      move(1)
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault()
      move(-1)
    } else if (event.key === "Enter") {
      event.preventDefault()
      if (active) runRow(active, event.metaKey || event.ctrlKey)
    } else if (event.key === "Tab" && plain) {
      event.preventDefault()
      if (active?.item.scope?.kind === "project") enterScope(active.item.scope)
    } else if (event.key === "ArrowRight" && plain && caretAtEnd && active?.item.scope?.kind === "project") {
      event.preventDefault()
      enterScope(active.item.scope)
    } else if (event.key === "ArrowRight" && plain && empty && !scope) {
      event.preventDefault()
      switchCategory(1)
    } else if (event.key === "ArrowLeft" && plain && empty) {
      event.preventDefault()
      if (scope) leaveScope()
      else switchCategory(-1)
    } else if (event.key === "Backspace" && empty && scope) {
      event.preventDefault()
      leaveScope()
    }
  }
  const onKeyRef = useRef(onKey)
  useLayoutEffect(() => {
    onKeyRef.current = onKey
  })
  useEffect(() => {
    if (!open) return
    const handle = (event: KeyboardEvent) => onKeyRef.current(event)
    paletteKeys = handle
    return () => {
      if (paletteKeys === handle) paletteKeys = null
    }
  }, [open])

  const placeholder = scope?.kind === "project" ? `Search in ${scope.name}…` : scope?.kind === "models" ? "Switch to a model…" : (CATEGORIES.find((entry) => entry.id === category)?.placeholder ?? "")
  const prefixLabel = prefix ? PREFIXES.get(prefix)?.label : undefined
  const askingGitHub = category === "pulls" || prefix === "#"
  const emptyLine =
    category === "files" && files.status === "loading"
      ? "Reading the project…"
      : category === "files" && files.error
        ? files.error
        : askingGitHub && pulls.status === "unavailable"
          ? (pulls.reason ?? "No pull requests")
          : askingGitHub && pulls.status === "loading"
            ? "Asking GitHub…"
            : "No matches"

  let index = -1
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-palette-scrim className="palette-scrim fixed inset-0 z-50 bg-background/20" />
        <DialogPrimitive.Content
          ref={contentRef}
          aria-label="Command palette"
          aria-describedby={undefined}
          data-command-palette
          data-category={category}
          data-scope={scope?.kind}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            inputRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            // What ran and put focus somewhere keeps it there; dismissed, or what ran left focus nowhere, it goes back.
            event.preventDefault()
            const focused = document.activeElement
            if (ranRef.current && focused && focused !== document.body && !contentRef.current?.contains(focused)) return
            const back = returnRef.current
            returnRef.current = null
            if (back?.isConnected) back.focus({ preventScroll: true })
          }}
          className="palette-panel overlay-panel fixed top-[14vh] left-1/2 z-50 flex w-[calc(100%_-_2rem)] max-w-[640px] -translate-x-1/2 flex-col overflow-hidden outline-hidden"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex h-12 shrink-0 items-center gap-2.5 px-4">
            <SearchIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
            {scope ? (
              <button
                type="button"
                tabIndex={-1}
                data-palette-scope
                onClick={leaveScope}
                className="pressable flex h-6 shrink-0 items-center gap-1 bg-fill-selected px-1.5 text-label text-foreground hover:bg-fill-hover"
                title="Back out (Esc)"
              >
                {scope.kind === "project" ? scope.name : "Models"}
                <XIcon className="size-3 text-faint" aria-hidden />
              </button>
            ) : prefixLabel ? (
              <span data-palette-prefix className="flex h-6 shrink-0 items-center bg-fill-selected px-1.5 text-label text-foreground">
                {prefixLabel}
              </span>
            ) : null}
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              role="combobox"
              aria-expanded
              aria-controls="palette-results"
              aria-activedescendant={active ? `palette-row-${at}` : undefined}
              className="h-full min-w-0 flex-1 bg-transparent text-ui placeholder:text-faint focus:outline-none"
            />
          </div>
          {scope ? null : (
            <div role="tablist" aria-label="Search in" className="flex shrink-0 gap-0.5 overflow-x-auto px-2.5 pb-1.5 [scrollbar-width:none]">
              {CATEGORIES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  tabIndex={-1}
                  data-palette-tab={entry.id}
                  aria-selected={entry.id === category}
                  onClick={() => {
                    setCategory(entry.id)
                    inputRef.current?.focus()
                  }}
                  className="pressable h-6 px-2 text-label font-medium text-faint transition-colors duration-100 hover:text-foreground aria-selected:bg-fill-selected aria-selected:text-foreground"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}

          <div id="palette-results" role="listbox" ref={listRef} className="palette-list max-h-[min(420px,60vh)] scroll-py-1.5 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
            {rows.length === 0 ? (
              <p data-palette-empty className="px-2 py-10 text-center text-ui text-faint">
                {emptyLine}
              </p>
            ) : (
              sections.map((section) => (
                <div key={`${section.group}:${section.label}`} role="group" aria-label={section.label} data-palette-group={section.group}>
                  <div className="flex h-7 items-end justify-between px-2.5 pb-1 text-label font-medium text-faint">
                    <span>{section.label}</span>
                    {section.more > 0 ? <span className="tabular font-normal">{section.more} more</span> : null}
                  </div>
                  {section.rows.map((row) => {
                    index += 1
                    return <PaletteRowView key={row.item.id} row={row} index={index} active={index === at} now={now} onHover={setCursor} onRun={runRow} />
                  })}
                </div>
              ))
            )}
          </div>
          <PaletteFooter row={active} scope={scope} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** The keys that do something for the row under the cursor, said along the bottom. */
function PaletteFooter({ row, scope }: { row: PaletteRow | undefined; scope: PaletteScope | undefined }) {
  const item = row?.item
  return (
    <div data-palette-footer className="flex h-9 shrink-0 pointer-coarse:hidden items-center gap-4 bg-shell/60 px-4 text-label text-faint">
      {item ? <Hint keys={["↩"]} label={item.verb ?? "Open"} /> : null}
      {item?.alternate ? <Hint keys={["⌘", "↩"]} label={item.alternate.label} /> : null}
      {item?.scope?.kind === "project" ? <Hint keys={["⇥"]} label={`In ${item.scope.name}`} /> : null}
      <span className="flex-1" />
      {scope ? <Hint keys={["Esc"]} label="Back" /> : <Hint keys={["←", "→"]} label="Tabs" />}
    </div>
  )
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Keys keys={keys} />
      {label}
    </span>
  )
}

const PaletteRowView = memo(function PaletteRowView({ row, index, active, now, onHover, onRun }: { row: PaletteRow; index: number; active: boolean; now: number; onHover: (index: number) => void; onRun: (row: PaletteRow, alternate: boolean) => void }) {
  const { item, match } = row
  const titleLit = match && match.field === 0 ? match.indices : []
  // A row found by something besides its title says what: "theme" under Appearance.
  const why = match && match.field > 0 ? item.fields[match.field] : undefined
  // Only a word or a name: a command's list of search words reads as noise, so its hint stands instead.
  const showWhy = why !== undefined && why.text.length <= 32 && !(item.meta ?? "").toLowerCase().includes(why.text.toLowerCase())
  return (
    <div
      id={`palette-row-${index}`}
      role="option"
      aria-selected={active}
      data-index={index}
      data-palette-row={item.id}
      data-selected={active || undefined}
      onMouseMove={() => {
        if (!active) onHover(index)
      }}
      onClick={(event) => onRun(row, event.metaKey || event.ctrlKey)}
      className={cn("flex h-10 cursor-default items-center gap-2.5 px-2.5", active && "bg-fill-selected")}
    >
      <RowIcon icon={item.icon} />
      <span data-palette-title className="min-w-0 shrink truncate text-ui text-foreground">
        <Lit text={item.title} indices={titleLit} />
      </span>
      {showWhy ? (
        <span data-palette-meta className="min-w-0 max-w-[45%] shrink-[2] truncate text-label text-faint">
          <Lit text={why.text} indices={match?.indices ?? []} />
        </span>
      ) : item.meta ? (
        <span data-palette-meta className="min-w-0 max-w-[45%] shrink-[2] truncate text-label text-faint">
          {item.meta}
        </span>
      ) : null}
      <span className="flex-1" />
      {item.at && item.group !== "projects" ? <span className="tabular w-10 shrink-0 text-right text-label text-faint">{relativeAt(item.at, now)}</span> : null}
      {item.keys?.length ? <Keys keys={[...item.keys]} /> : null}
      {item.scope ? <ChevronRightIcon className="size-3.5 shrink-0 text-faint" aria-hidden /> : null}
    </div>
  )
})

function relativeAt(at: number, now: number): string {
  return now && at > now ? "now" : formatRelative(at)
}

function Lit({ text, indices }: { text: string; indices: readonly number[] }) {
  if (!indices.length) return <>{text}</>
  return (
    <>
      {litRuns(text, indices).map((run, index) =>
        run.lit ? (
          <mark key={index} data-lit className="bg-transparent font-semibold text-foreground">
            {run.text}
          </mark>
        ) : (
          <span key={index}>{run.text}</span>
        )
      )}
    </>
  )
}

const GLYPHS = {
  action: <ZapIcon />,
  project: <FolderIcon />,
  pull: <GitPullRequestIcon />,
  "pull-merged": <GitMergeIcon />,
  "pull-closed": <GitPullRequestClosedIcon />,
  automation: <TimerIcon />,
  setting: <SettingsIcon />,
  model: <SparklesIcon />,
  agent: <SlashIcon />,
  inbox: <InboxIcon />,
  new: <PlusIcon />,
} satisfies Record<GlyphName, ReactNode>

function RowIcon({ icon }: { icon: PaletteIcon }) {
  if (icon.kind === "file") return <FileIcon path={icon.path} className="size-4 shrink-0" />
  if (icon.kind === "glyph") return <span className="flex size-4 shrink-0 items-center justify-center text-faint [&_svg]:size-3.5">{GLYPHS[icon.name]}</span>
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <LiveMark state={icon.state} kind={icon.kind === "fin" ? "fin" : "thread"} size={16} cut="var(--popover)" className="live-mark-still">
        {icon.harness ? <HarnessIcon harness={icon.harness} /> : <BotIcon />}
      </LiveMark>
    </span>
  )
}

function projectActions(scope: Extract<PaletteScope, { kind: "project" }>): PaletteItem[] {
  const base = { group: "actions" as const, primary: 1, project: scope.path, icon: { kind: "glyph" as const, name: "new" as const } }
  return [
    { ...base, id: `scope:new:${scope.path}`, title: `New Thread in ${scope.name}`, fields: fieldsOf(`New Thread in ${scope.name}`, "start create"), suggested: -2, verb: "Start", run: () => void actions.newConversationIn(scope.path) },
    { ...base, id: `scope:settings:${scope.path}`, title: `${scope.name} settings`, fields: fieldsOf(`${scope.name} settings`, "project settings scripts environment"), icon: { kind: "glyph", name: "setting" }, suggested: -1, run: () => openProjectSettings(scope.path) },
  ]
}

function searchConversations(term: string): PaletteItem {
  return {
    id: "search:conversations",
    group: "actions",
    title: `Search every conversation for “${term}”`,
    fields: fieldsOf(term),
    primary: 1,
    meta: "and the project's files",
    keys: formatChord("mod+shift+f"),
    icon: { kind: "glyph", name: "action" },
    verb: "Search",
    run: () => search.open(term),
  }
}

function typedProject(term: string): PaletteItem {
  return {
    id: "project:typed",
    group: "projects",
    title: term,
    fields: fieldsOf(term),
    primary: 1,
    meta: githubRepository(term) ? "Clone or open" : "Browse folders",
    icon: { kind: "glyph", name: "project" },
    verb: "Open project",
    run: () => openProjectPalette({ query: term }),
  }
}

/** With nothing found, the words typed start a Thread, in the project scoped to if there is one. */
function newThreadWith(term: string, scope: PaletteScope | undefined): PaletteItem {
  return {
    id: "new-thread:typed",
    group: "actions",
    title: `New Thread: ${term}`,
    fields: fieldsOf(term),
    primary: 1,
    meta: scope?.kind === "project" ? `in ${scope.name}` : "with these words in its composer",
    icon: { kind: "glyph", name: "new" },
    verb: "Start",
    run: () => {
      void (scope?.kind === "project" ? actions.newConversationIn(scope.path) : actions.newSession())
      // The new Thread's composer mounts a frame or two after; the words go in once it has.
      requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("mako:insert", { detail: term }))))
    },
  }
}

/**
 * The project's files: typed, the host's index of the workspace finds them, as the Files panel does, and until its
 * answer for exactly this query comes, the list held here; with nothing typed, the changed ones first.
 */
interface FileRows {
  items: PaletteItem[]
  status: "loading" | "ready" | "failed"
  error?: string
}

function useFileItems(active: boolean, term: string): FileRows {
  const index = useWorkspaceFiles(active)
  const cwd = useSession((state) => state.meta?.cwd)
  const finder = useMemo(() => (cwd ? workspaceFiles(cwd) : undefined), [cwd])
  const [found, setFound] = useState<FileFindResults & { root: string }>()
  useEffect(() => {
    if (!active || !term || !finder || !cwd) return
    let current = true
    void finder.find(term, 60).then((next) => {
      if (current) setFound({ ...next, root: cwd })
    }, () => undefined)
    return () => {
      current = false
    }
  }, [active, term, finder, cwd])
  const items = useMemo((): PaletteItem[] => {
    if (!active) return []
    const ordered = term
      ? found && found.root === cwd && found.query === term
        ? found.hits.map((hit) => hit.path)
        : rankFiles(index.files, term, (file) => file.path).slice(0, 60).map((file) => file.path)
      : [...index.files].sort((a, b) => Number(Boolean(b.changed)) - Number(Boolean(a.changed))).slice(0, 60).map((file) => file.path)
    return ordered.map((path, order): PaletteItem => {
      const name = path.split("/").at(-1) ?? path
      return {
        id: `file:${path}`,
        group: "files",
        title: name,
        fields: fieldsOf(name, path),
        // A file the host found by its path lists too, lit where its name matches.
        primary: 2,
        meta: path.includes("/") ? path.slice(0, path.length - name.length - 1) : undefined,
        icon: { kind: "file", path },
        suggested: order,
        alternate: { label: "Mention in the composer", run: () => window.dispatchEvent(new CustomEvent("mako:insert", { detail: `@${path} ` })) },
        run: () => void viewer.open(path),
      }
    })
  }, [active, term, found, cwd, index.files])
  return { items, status: index.kind === "loading" ? "loading" : index.kind === "failed" ? "failed" : "ready", ...(index.kind === "failed" && { error: index.error }) }
}

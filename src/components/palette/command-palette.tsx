import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { Eyebrow, Keys } from "@/components/ui/kit"
import {
  commands,
  formatChord,
  keysFor,
  matchesChord,
  useCommands,
  type DeskCommand,
} from "@/extend/commands"
import { fuzzy, rank } from "@/lib/fuzzy"
import { actions, useCanChooseFolder, useSession } from "@/state/session"
import { asksForProject } from "@/lib/project-query"
import { githubRepository } from "@mako/host/contracts/projects"
import { openProjectPalette } from "@/state/open-project"
import { threads, useThreads } from "@/state/threads"
import { modelKey, noteModelUse, prefsStore, usePrefs } from "@/state/prefs"
import { useWorkspaceFiles } from "@/state/files"
import { workspaceFiles } from "@/state/file-tree"
import type { FileFindResults } from "@mako/host/contracts/file-index"
import { viewer } from "@/state/viewer"
import { PROJECT_SETTINGS_COMMAND } from "@/desk/project-commands"
import { cn } from "@/lib/utils"
import { SearchIcon } from "lucide-react"

interface Entry {
  id: string
  section: string
  title: string
  hint?: string
  keywords?: string
  keys?: string[]
  run: () => void
}

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

/** The desk command a chord runs, if any; what the keyboard layer would run for it. */
function commandFor(event: KeyboardEvent): DeskCommand | undefined {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return undefined
  const overrides = prefsStore.get().keybindings
  return commands.list().find((command) => {
    const keys = keysFor(command, overrides)
    return keys !== undefined && matchesChord(event, keys) && command.when?.() !== false
  })
}

/**
 * The command palette: a layer over whatever is open, Settings and dialogs included. It's Radix's dialog so it takes
 * its place in the stack of layers: the one beneath keeps its state but gives up focus, the pointer and Escape until
 * this closes, and focus goes back to where it was (the composer, a Settings field) unless what ran put it elsewhere.
 *
 * The caret is in the field on the frame the chord lands; the panel arrives and leaves on the menu's motion tokens
 * without delaying it.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  /**
   * Commands, or files.
   *
   * Two modes rather than one merged list, because they answer different
   * questions and a merged list serves both badly: typing `session` should not
   * bury the command you meant under forty files whose path happens to contain
   * it. ⌘K asks "what can I do", ⌘P asks "where is that file".
   */
  const [mode, setMode] = useState<"commands" | "files">("commands")
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  /** Whether it closed by running something, which then owns focus, or by being dismissed, which gives focus back. */
  const ranRef = useRef(false)
  /** Where focus was when it opened: Radix gives focus back to a dialog's trigger, and the palette has none. */
  const returnRef = useRef<HTMLElement | null>(null)

  const fileIndex = useWorkspaceFiles(open && mode === "files")
  const { files } = fileIndex
  // Typed, a file is found by the host's index of the workspace, as the Files panel finds it.
  const cwd = useSession((state) => state.meta?.cwd)
  const finder = useMemo(() => (cwd ? workspaceFiles(cwd) : undefined), [cwd])
  const [found, setFound] = useState<FileFindResults & { root: string }>()
  const term = query.trim()
  useEffect(() => {
    if (!open || mode !== "files" || !term || !finder || !cwd) return
    let current = true
    void finder.find(term, 60).then((next) => {
      if (current) setFound({ ...next, root: cwd })
    }, () => undefined)
    return () => {
      current = false
    }
  }, [open, mode, term, finder, cwd])
  const deskCommands = useCommands()
  const keybindings = usePrefs((prefs) => prefs.keybindings)
  const favoriteModels = usePrefs((prefs) => prefs.favoriteModels)
  const recentModels = usePrefs((prefs) => prefs.recentModels)
  const sessions = useThreads((state) => state.threads)
  const models = useSession((state) => state.models)
  const piCommands = useSession((state) => state.capabilities.commands)
  const activeModel = useSession((state) => state.meta?.model)
  const canChooseFolder = useCanChooseFolder()

  const close = useCallback((ran = false) => {
    ranRef.current = ran
    setOpen(false)
  }, [])

  const openRef = useRef({ open, mode })
  // Before paint, so a chord pressed the frame after a switch reads the mode it switched to.
  useLayoutEffect(() => {
    openRef.current = { open, mode }
  })
  useEffect(() => {
    const show = (next: "commands" | "files") => () => {
      const now = openRef.current
      // The chord that opened it closes it; the other mode's chord switches to it, keeping what's typed.
      if (now.open && now.mode === next) {
        close()
        return
      }
      if (!now.open) {
        setQuery("")
        setCursor(0)
        setFound(undefined)
        ranRef.current = false
        returnRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
      }
      setMode(next)
      setOpen(true)
      inputRef.current?.focus()
    }
    const commands = show("commands")
    const quickOpen = show("files")
    window.addEventListener("mako:palette", commands)
    window.addEventListener("mako:quick-open", quickOpen)
    return () => {
      window.removeEventListener("mako:palette", commands)
      window.removeEventListener("mako:quick-open", quickOpen)
    }
  }, [close])

  /**
   * Files, ranked.
   *
   * With no query the changed ones come first: in an agent session those are
   * the files you were just discussing, and they are a small enough set to be
   * useful rather than arbitrary.
   */
  const fileEntries = useMemo<Entry[]>(() => {
    // The host's hits for exactly this query in this project; until they come, the list read here, never the hits for
    // a shorter query, which name files that don't match what's typed.
    const ordered = term
      ? found && found.root === cwd && found.query === term
        ? found.hits.map((hit) => ({ path: hit.path }))
        : rank(files, term, (file) => file.path).slice(0, 60)
      : [...files].sort((a, b) => Number(Boolean(b.changed)) - Number(Boolean(a.changed))).slice(0, 60)
    return ordered.map((file) => ({
      id: `file:${file.path}`,
      section: "Open file",
      title: file.path.split("/").at(-1) ?? file.path,
      hint: file.path,
      run: () => void viewer.open(file.path),
    }))
  }, [files, found, term, cwd])

  // Read as it opens, and kept while it leaves, so the list fades out as it was: closed, the palette asks no command
  // whether it applies.
  const [opening, setOpening] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) setOpening((value) => value + 1)
  }
  const entries = useMemo<Entry[]>(() => {
    if (opening === 0) return []
    const list: Entry[] = deskCommands
      .filter((command) => command.when?.() !== false)
      .map((command) => toEntry(command, keybindings))

    for (const command of piCommands) {
      list.push({
        id: `mako:${command.name}`,
        section: "Agent",
        title: `/${command.name}`,
        hint: command.description,
        run: () => void actions.runCommand(command.name),
      })
    }

    for (const model of models) {
      const key = modelKey(model.provider, model.id)
      const current = activeModel?.provider === model.provider && activeModel.id === model.id
      list.push({
        id: `model:${key}`,
        section: favoriteModels.includes(key)
          ? "Favorite models"
          : recentModels.includes(key)
            ? "Recent models"
            : "Switch model",
        title: model.name,
        hint: current ? `${model.provider} · current` : model.provider,
        run: () => {
          noteModelUse(key)
          void actions.setModel(model.provider, model.id)
        },
      })
    }

    for (const session of sessions.slice(0, 40)) {
      list.push({
        id: `session:${session.path}`,
        section: "Open session",
        title: session.title ?? "Untitled session",
        hint: [session.harness, session.cwd].filter(Boolean).join(" · "),
        run: () => void threads.view(session),
      })
    }

    return list
  }, [
    opening,
    activeModel,
    deskCommands,
    favoriteModels,
    keybindings,
    models,
    piCommands,
    recentModels,
    sessions,
  ])

  const results = useMemo(() => {
    if (mode === "files") return fileEntries
    const term = query.trim()
    if (!term) {
      // No query: show the desk's own verbs plus models the user chose to keep close.
      return entries.filter(
        (entry) =>
          !entry.id.startsWith("session:") &&
          !entry.id.startsWith(PROJECT_SETTINGS_COMMAND) &&
          (!entry.id.startsWith("model:") ||
            entry.section === "Favorite models" ||
            entry.section === "Recent models")
      )
    }
    const scored: Array<{ entry: Entry; score: number }> = []
    for (const entry of entries) {
      const match = fuzzy(term, `${entry.title} ${entry.section} ${entry.hint ?? ""} ${entry.keywords ?? ""}`)
      if (match) scored.push({ entry, score: match.score })
    }
    scored.sort((a, b) => b.score - a.score)
    const ranked = scored.slice(0, 60).map((item) => item.entry)
    // A path or a GitHub address is a project to open: Open project takes it from here, as typed.
    if (canChooseFolder && asksForProject(term))
      return [{ id: "project:typed", section: "Open project", title: term, hint: githubRepository(term) ? "Clone or open" : "Browse folders", run: () => openProjectPalette({ query: term }) }, ...ranked]
    return ranked
  }, [entries, fileEntries, mode, query, canChooseFolder])

  const [lastQuery, setLastQuery] = useState(query)
  if (lastQuery !== query) {
    setLastQuery(query)
    setCursor(0)
  }

  const move = (delta: number) => {
    setCursor((value) => {
      const next = (Math.min(value, results.length - 1) + delta + results.length) % Math.max(results.length, 1)
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" })
      return next
    })
  }

  const runEntry = (entry: Entry, alternate: boolean) => {
    close(true)
    // ⌘↩ on a file puts it in the composer rather than opening it — the
    // other reason you went looking for it.
    if (mode === "files" && alternate && entry.hint) {
      window.dispatchEvent(new CustomEvent("mako:insert", { detail: `@${entry.hint} ` }))
      return
    }
    entry.run()
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.isComposing) return
    const command = commandFor(event)
    if (command) {
      // ⌘K closes it and ⌘P switches it, through their commands; any other command closes it and runs.
      if (command.id !== PALETTE_COMMAND && command.id !== QUICK_OPEN_COMMAND) close(true)
      return
    }
    // Immediate: the composer's @ list listens on the window's capture phase too, after this.
    event.stopImmediatePropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      close()
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      move(event.key === "ArrowDown" ? 1 : -1)
    } else if (event.key === "Enter") {
      event.preventDefault()
      const entry = results[Math.min(cursor, results.length - 1)]
      if (entry) runEntry(entry, event.metaKey || event.ctrlKey)
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

  let lastSection = ""

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-palette-scrim
          className="fixed inset-0 z-50 bg-background/55 backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 data-open:duration-(--duration-menu) data-open:ease-(--ease-out) data-closed:animate-out data-closed:fade-out-0 data-closed:duration-(--duration-menu-out) data-closed:ease-(--ease-swift) motion-reduce:animate-none"
        />
        <DialogPrimitive.Content
          ref={contentRef}
          aria-label="Command palette"
          aria-describedby={undefined}
          data-command-palette
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            inputRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            // What ran and put focus somewhere keeps it there; dismissed, or what ran left focus nowhere, it goes back.
            event.preventDefault()
            const at = document.activeElement
            if (ranRef.current && at && at !== document.body && !contentRef.current?.contains(at)) return
            const back = returnRef.current
            returnRef.current = null
            if (back?.isConnected) back.focus({ preventScroll: true })
          }}
          className="overlay-panel fixed top-[14vh] left-1/2 z-50 w-[calc(100%_-_2rem)] max-w-dialog -translate-x-1/2 overflow-hidden outline-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-open:slide-in-from-top-1 data-open:duration-(--duration-menu) data-open:ease-(--ease-out) data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] data-closed:duration-(--duration-menu-out) data-closed:ease-(--ease-swift) motion-reduce:animate-none"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex h-11 items-center gap-2.5 border-b border-hairline px-3.5">
            <SearchIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={mode === "files" ? "Open a file by name" : "Search commands, models, sessions…"}
              className="h-full min-w-0 flex-1 bg-transparent text-ui placeholder:text-faint focus:outline-none"
            />
          </div>

          <div ref={listRef} className="max-h-[22rem] overflow-y-auto overscroll-contain p-1.5">
            {results.length === 0 ? (
              <p className="px-2 py-8 text-center text-ui text-faint">
                {mode === "files" && fileIndex.kind === "loading" ? "Reading the project…" : mode === "files" && fileIndex.kind === "failed" ? fileIndex.error : "No matches"}
              </p>
            ) : (
              results.map((entry, index) => {
                const header = entry.section !== lastSection ? entry.section : null
                lastSection = entry.section
                return (
                  <div key={entry.id}>
                    {header ? <Eyebrow className="px-1.5 pt-2 pb-1">{header}</Eyebrow> : null}
                    <button
                      type="button"
                      tabIndex={-1}
                      data-index={index}
                      onMouseMove={() => setCursor(index)}
                      onClick={(event) => runEntry(entry, event.metaKey || event.ctrlKey)}
                      className={cn(
                        "flex w-full items-center gap-2 px-2 py-1.5 text-left",
                        index === cursor && "bg-fill-selected"
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-ui">{entry.title}</span>
                      {entry.hint ? (
                        <span className="shrink-0 truncate text-label text-faint">{entry.hint}</span>
                      ) : null}
                      {entry.keys?.length ? <Keys keys={entry.keys} /> : null}
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function toEntry(
  command: DeskCommand,
  keybindings: Readonly<Record<string, string>>
): Entry {
  return {
    id: command.id,
    section: command.section,
    title: command.title,
    hint: command.hint,
    keywords: command.keywords,
    keys: formatChord(keysFor(command, keybindings)),
    run: () => void command.run(),
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Eyebrow, Keys } from "@/components/ui/kit"
import {
  formatChord,
  keysFor,
  useCommands,
  type DeskCommand,
} from "@/extend/commands"
import { fuzzy, rank } from "@/lib/fuzzy"
import { actions, useSession } from "@/state/session"
import { threads, useThreads } from "@/state/threads"
import { modelKey, noteModelUse, usePrefs } from "@/state/prefs"
import { useWorkspaceFiles } from "@/state/files"
import { workspaceFiles } from "@/state/file-tree"
import type { FileFindResults } from "@mako/host/contracts/file-index"
import { viewer } from "@/state/viewer"
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
 * The command palette.
 *
 * Deliberately unanimated. This is opened dozens of times a day by keyboard,
 * and any entrance transition — however tasteful — puts a delay between the
 * chord and the caret. Raycast gets this right by having no animation at all.
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

  const fileIndex = useWorkspaceFiles(open && mode === "files")
  const { files } = fileIndex
  // Typed, a file is found by the host's index of the workspace, as the Files panel finds it.
  const cwd = useSession((state) => state.meta?.cwd)
  const finder = useMemo(() => (cwd ? workspaceFiles(cwd) : undefined), [cwd])
  const [found, setFound] = useState<FileFindResults>()
  const term = query.trim()
  useEffect(() => {
    if (!open || mode !== "files" || !term || !finder) return
    let current = true
    void finder.find(term, 60).then((next) => {
      if (current) setFound(next)
    }, () => undefined)
    return () => {
      current = false
    }
  }, [open, mode, term, finder])
  const deskCommands = useCommands()
  const keybindings = usePrefs((prefs) => prefs.keybindings)
  const favoriteModels = usePrefs((prefs) => prefs.favoriteModels)
  const recentModels = usePrefs((prefs) => prefs.recentModels)
  const sessions = useThreads((state) => state.threads)
  const models = useSession((state) => state.models)
  const piCommands = useSession((state) => state.capabilities.commands)
  const activeModel = useSession((state) => state.meta?.model)

  const close = useCallback(() => {
    setOpen(false)
    setQuery("")
    setCursor(0)
  }, [])

  useEffect(() => {
    const show = (next: "commands" | "files") => () => {
      setQuery("")
      setCursor(0)
      setMode(next)
      setOpen(true)
    }
    const commands = show("commands")
    const quickOpen = show("files")
    window.addEventListener("mako:palette", commands)
    window.addEventListener("mako:quick-open", quickOpen)
    return () => {
      window.removeEventListener("mako:palette", commands)
      window.removeEventListener("mako:quick-open", quickOpen)
    }
  }, [])

  /**
   * Files, ranked.
   *
   * With no query the changed ones come first: in an agent session those are
   * the files you were just discussing, and they are a small enough set to be
   * useful rather than arbitrary.
   */
  const fileEntries = useMemo<Entry[]>(() => {
    const ordered = term
      ? found && (found.query === term || term.startsWith(found.query))
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
  }, [files, found, term])

  // Read as it opens: closed, the palette lists nothing, and asks no command whether it applies.
  const entries = useMemo<Entry[]>(() => {
    if (!open) return []
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
    open,
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
    return scored.slice(0, 60).map((item) => item.entry)
  }, [entries, fileEntries, mode, query])

  const [lastQuery, setLastQuery] = useState(query)
  if (lastQuery !== query) {
    setLastQuery(query)
    setCursor(0)
  }

  if (!open) return null

  const move = (delta: number) => {
    setCursor((value) => {
      const next = (value + delta + results.length) % Math.max(results.length, 1)
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" })
      return next
    })
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      move(1)
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      move(-1)
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const entry = results[cursor]
      if (!entry) return
      close()
      // ⌘↩ on a file puts it in the composer rather than opening it — the
      // other reason you went looking for it.
      if (mode === "files" && (event.metaKey || event.ctrlKey) && entry.hint) {
        window.dispatchEvent(new CustomEvent("mako:insert", { detail: `@${entry.hint} ` }))
        return
      }
      entry.run()
    }
  }

  let lastSection = ""

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/55 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        onKeyDown={onKeyDown}
        className="overlay-panel w-full max-w-dialog overflow-hidden"
      >
        <div className="flex h-11 items-center gap-2.5 border-b border-hairline px-3.5">
          <SearchIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
          <input
            autoFocus
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
                    data-index={index}
                    onMouseMove={() => setCursor(index)}
                    onClick={() => {
                      close()
                      entry.run()
                    }}
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
      </div>
    </div>
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

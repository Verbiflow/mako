import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import {
  DownloadIcon,
  FileIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSearchIcon,
  ShieldIcon,
  type LucideIcon,
} from "lucide-react"
import { Eyebrow, Keys, Meter } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { formatRelative } from "@/lib/format"
import { fuzzy } from "@/lib/fuzzy"
import { completePath, projectNameProblem, projectQuery, tildePath } from "@/lib/project-query"
import { cn } from "@/lib/utils"
import type { FolderBrowse } from "@mako/host/contracts/projects"
import { checkoutHeadsStore, checkoutLabel, followCheckouts } from "@/state/checkout-heads"
import {
  FOUND_SHOWN,
  RECENT_SHOWN,
  cancelClone,
  chooseCloneFolder,
  chooseInFinder,
  closeProjectPalette,
  cloneDirectory,
  createProject,
  dropClone,
  newFound,
  openLatestThread,
  openPrivacySettings,
  openProject,
  browseFolders,
  scanGuardedFolders,
  startClone,
  useOpenProject,
  useRecentProjects,
  type CloneView,
  type OpenProjectMode,
  type RecentProject,
} from "@/state/open-project"
import { useSession } from "@/state/session"
import { createHook } from "@/state/store"
import { localWords } from "@mako/protocol/computer-words"

const useHeads = createHook(checkoutHeadsStore)

interface How {
  meta: boolean
  alt: boolean
}

/** One line of the palette. Without `run` it's a quiet line to read, which the cursor steps over. */
interface Row {
  id: string
  section: string
  icon: LucideIcon
  title: string
  detail?: string
  badge?: string
  keys?: string[]
  /** What the selected row says its keys do, beside them. */
  keysLabel?: string
  /** Tab puts this in the field: a folder's path with a slash, to go into it. */
  complete?: string
  run?: (how: How) => void
  /** A clone under way: its progress in percent, or null before Git says. */
  progress?: number | null
  wrap?: boolean
}

/** The palette's field, after a click or a chooser took the focus away. */
function focusField() {
  document.querySelector<HTMLInputElement>("[data-open-project-field]")?.focus()
}

const PLACEHOLDER = {
  open: "Open a project: type a path, paste a GitHub URL, or search",
  clone: "Paste a GitHub URL, or type owner/name",
  create: "Name the new project",
} satisfies Record<OpenProjectMode, string>

/**
 * Open project (⌘O): the one place a project starts. Nothing typed, it lists the folders worked in, the checkouts
 * found on this Mac and the ways to start something new; a path browses folders (Tab goes in, Enter opens); a GitHub
 * address clones; other words find a project by name.
 *
 * Unanimated, as the command palette is: it's opened by keyboard many times a day.
 */
export function OpenProjectPalette() {
  const open = useOpenProject((state) => state.open)
  if (!open) return null
  return <OpenProjectDialog />
}

function OpenProjectDialog() {
  const opened = useOpenProject((state) => state.opened)
  const asked = useOpenProject((state) => state.query)
  const askedMode = useOpenProject((state) => state.mode)
  const found = useOpenProject((state) => state.found)
  const home = useOpenProject((state) => state.home)
  const clones = useOpenProject((state) => state.clones)
  const adopt = useOpenProject((state) => state.adopt)
  const cwd = useSession((state) => state.meta?.cwd)
  const recent = useRecentProjects()
  const heads = useHeads((state) => state.heads)
  const [query, setQuery] = useState(asked)
  const [mode, setMode] = useState<OpenProjectMode>(askedMode)
  const [cursor, setCursor] = useState(0)
  const [shownClone, setShownClone] = useState<string | undefined>()
  const [creating, setCreating] = useState<{ path: string; error?: string } | undefined>()
  const [browse, setBrowse] = useState<{ text: string; result: FolderBrowse } | undefined>()
  const listRef = useRef<HTMLDivElement>(null)

  // Asked to open again while open (⌘O, or ⌘K handing a path over): take what it was asked with.
  const [lastOpened, setLastOpened] = useState(opened)
  if (lastOpened !== opened) {
    setLastOpened(opened)
    setQuery(asked)
    setMode(askedMode)
    setCursor(0)
  }
  const [lastQuery, setLastQuery] = useState(query)
  if (lastQuery !== query) {
    setLastQuery(query)
    setCursor(0)
    setCreating(undefined)
  }

  const parsed = useMemo(() => projectQuery(query), [query])
  const into = cloneDirectory(recent)
  const known = useMemo(() => new Set(recent.map((each) => each.path)), [recent])
  const fresh = useMemo(() => newFound(found?.checkouts ?? [], recent), [found, recent])
  const tilde = useCallback((path: string) => tildePath(path, home), [home])

  // The path whose folders are listed: what's typed; for a repository, where its clone would go; for a new project, its folder.
  const name = query.trim()
  const lookup =
    parsed.kind === "path" ? parsed.text
      : parsed.kind === "repository" && into ? `${into}/${parsed.repository.name}`
        : mode === "create" && into && name && !projectNameProblem(name) ? `${into}/${name}`
          : undefined
  useEffect(() => {
    if (!lookup) return
    let current = true
    const timer = setTimeout(() => {
      void browseFolders(lookup, cwd).then((result) => {
        if (current && result) setBrowse({ text: lookup, result })
      })
    }, 60)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [lookup, cwd])
  const listing = browse && browse.text === lookup ? browse.result : undefined

  // Branches for the rows that name one.
  const shownPaths = useMemo(() => recent.slice(0, 24).map((each) => each.path), [recent])
  useEffect(() => followCheckouts(shownPaths), [shownPaths])

  const clone: CloneView | undefined = shownClone ? clones[shownClone] : undefined

  // Built each render: a few dozen rows, read from what the hooks above hold.
  const rows = ((): Row[] => {
    const list: Row[] = []
    const recentRow = (project: RecentProject, selectedHint = true): Row => {
      const branch = checkoutLabel(heads[project.path])
      const row: Row = {
        id: `recent:${project.path}`,
        section: "Recent",
        icon: FolderIcon,
        title: project.name,
        detail: [tilde(project.path), branch, formatRelative(project.at)].filter(Boolean).join(" · "),
        run: (how) => (how.meta ? openLatestThread(project) : void openProject(project.path)),
      }
      if (selectedHint && project.latest) {
        row.keys = formatChord("mod+enter")
        row.keysLabel = "Latest Thread"
      }
      return row
    }
    const foundRow = (checkout: (typeof fresh)[number]): Row => ({
      id: `found:${checkout.path}`,
      section: localWords("On this Mac"),
      icon: FolderGit2Icon,
      title: checkout.name,
      detail: [tilde(checkout.path), checkout.remote, checkout.branch].filter(Boolean).join(" · "),
      run: () => void openProject(checkout.path),
    })
    const startRows: Row[] = [
      { id: "start:clone", section: "Start something new", icon: DownloadIcon, title: "Clone from GitHub…", run: () => toMode("clone") },
      { id: "start:new", section: "Start something new", icon: FolderPlusIcon, title: "New empty project…", run: () => toMode("create") },
      { id: "start:finder", section: "Start something new", icon: FolderSearchIcon, title: "Choose in Finder…", keys: formatChord("mod+shift+o"), run: () => chooseInFinder() },
    ]

    // A clone this palette started stands first while it runs or after it failed.
    if (clone && (clone.state.kind === "cloning" || clone.state.kind === "failed")) {
      if (clone.state.kind === "cloning") {
        list.push({
          id: `clone:${clone.id}`,
          section: "Clone",
          icon: DownloadIcon,
          title: `Cloning ${clone.repository} into ${tilde(clone.path)}`,
          detail: clone.state.phase,
          keys: ["Esc"],
          keysLabel: "Cancel",
          progress: clone.state.percent ?? null,
          wrap: true,
        })
      } else {
        const failed = clone
        const signIn = clone.state.signIn
        list.push({
          id: `clone:${clone.id}`,
          section: "Clone",
          icon: DownloadIcon,
          title: clone.state.message,
          wrap: true,
          keys: ["↩"],
          keysLabel: signIn ? "Try again" : "Clone into…",
          run: () => {
            dropClone(failed.id)
            if (signIn) void begin(failed.repository, failed.into)
            else void cloneElsewhere(failed.repository)
          },
        })
      }
      return list
    }

    if (mode === "create") {
      const problem = projectNameProblem(name)
      if (!name) list.push({ id: "create:hint", section: "New project", icon: FolderPlusIcon, title: `Type a name; it's made in ${into ? tilde(into) : "your home folder"}`, detail: "with git init" })
      else if (problem) list.push({ id: "create:problem", section: "New project", icon: FolderPlusIcon, title: problem, wrap: true })
      else if (into) {
        const path = `${into}/${name}`
        if (listing?.exact.kind === "folder") list.push({ id: "create:open", section: "New project", icon: FolderOpenIcon, title: `Open ${tilde(path)}`, detail: "already there", run: () => void openProject(path) })
        else if (listing?.exact.kind === "file") list.push({ id: "create:file", section: "New project", icon: FileIcon, title: `${tilde(path)} is a file; pick another name` })
        else list.push({ id: "create:make", section: adopt ? `Turn “${adopt.title}” into a project` : "New project", icon: FolderPlusIcon, title: adopt ? `Move it to ${tilde(path)}` : `Create ${tilde(path)}`, detail: adopt ? "with git init; its Thread goes on there" : "with git init", keys: formatChord("alt+enter"), keysLabel: "Make it elsewhere", run: (how) => (how.alt ? void createElsewhere(name) : void make(path, true)) })
      }
      if (creating?.error) list.push({ id: "create:error", section: "New project", icon: FolderPlusIcon, title: creating.error, wrap: true })
      return list
    }

    if (mode === "clone" && parsed.kind !== "repository") {
      list.push({ id: "clone:hint", section: "Clone", icon: DownloadIcon, title: name ? "That isn't a GitHub repository. Try owner/name, or paste its address." : `Clones go in ${into ? tilde(into) : "your home folder"}`, detail: name ? undefined : "Settings › Git › Clone into" })
      return list
    }

    if (parsed.kind === "repository") {
      const { owner, name: repo } = parsed.repository
      const label = `${owner}/${repo}`
      const target = into ? `${into}/${repo}` : undefined
      const cloned =
        listing?.exact.kind === "folder" && listing.exact.repository?.toLowerCase() === label.toLowerCase() ? listing.exact.path
          : (found?.checkouts ?? []).find((each) => each.remote?.toLowerCase() === label.toLowerCase())?.path
      if (cloned) list.push({ id: "repo:open", section: "Clone", icon: FolderGit2Icon, title: `Open ${tilde(cloned)}`, detail: "already cloned", badge: known.has(cloned) ? "In Mako" : undefined, run: () => void openProject(cloned) })
      if (target && cloned !== target) {
        const taken = listing?.exact.kind === "folder" || listing?.exact.kind === "file"
        list.push(taken
          ? { id: "repo:taken", section: "Clone", icon: DownloadIcon, title: `${tilde(target)} already exists`, detail: "Clone into another folder", keys: ["↩"], run: () => void cloneElsewhere(label) }
          : { id: "repo:clone", section: "Clone", icon: DownloadIcon, title: `Clone ${label} into ${tilde(target)}`, run: (how) => (how.alt ? void cloneElsewhere(label) : void begin(label, into!)) })
      }
      list.push({ id: "repo:elsewhere", section: "Clone", icon: FolderSearchIcon, title: "Clone into…", keys: formatChord("alt+enter"), run: () => void cloneElsewhere(label) })
      return list
    }

    if (parsed.kind === "path") {
      const exact = listing?.exact
      const entries: Row[] = (listing?.entries ?? []).map((entry) => ({
        id: `dir:${entry.path}`,
        section: "Folders",
        icon: entry.git ? FolderGit2Icon : FolderIcon,
        title: `${entry.name}/`,
        badge: known.has(entry.path) ? "In Mako" : undefined,
        complete: completePath(parsed.text, entry.name),
        keys: ["⇥"],
        keysLabel: "Go in",
        run: () => void openProject(entry.path),
      }))
      if (exact?.kind === "folder") list.push({ id: `open:${exact.path}`, section: "Folders", icon: exact.git ? FolderGit2Icon : FolderOpenIcon, title: `Open ${tilde(exact.path)}`, badge: known.has(exact.path) ? "In Mako" : undefined, run: () => void openProject(exact.path) })
      list.push(...entries)
      if (exact?.kind === "missing") list.push({ id: `create:${exact.path}`, section: "Folders", icon: FolderPlusIcon, title: `Create ${tilde(exact.path)} and open it`, run: () => void make(exact.path, false) })
      if (exact?.kind === "file") {
        const parent = exact.path.split("/").slice(0, -1).join("/") || "/"
        list.push({ id: `open:${parent}`, section: "Folders", icon: FolderOpenIcon, title: `Open ${tilde(parent)}`, detail: `the folder ${exact.path.split("/").at(-1)} is in`, run: () => void openProject(parent) })
      }
      if (creating?.error) list.push({ id: "path:error", section: "Folders", icon: FolderPlusIcon, title: creating.error, wrap: true })
      if (!listing) list.push({ id: "path:reading", section: "Folders", icon: FolderIcon, title: "Reading folders…" })
      return list
    }

    if (parsed.kind === "search") {
      const score = (text: string) => fuzzy(parsed.term, text)?.score
      const ranked = <T,>(items: readonly T[], text: (item: T) => string) =>
        items.map((item) => ({ item, score: score(text(item)) })).filter((each) => each.score !== undefined).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((each) => each.item)
      list.push(...ranked(recent, (each) => `${each.name} ${each.path}`).slice(0, RECENT_SHOWN).map((each) => recentRow(each)))
      list.push(...ranked(fresh, (each) => `${each.name} ${each.path} ${each.remote ?? ""}`).slice(0, FOUND_SHOWN).map(foundRow))
      list.push(...startRows.filter((row) => row.id === "start:finder" || score(row.title) !== undefined))
      return list
    }

    list.push(...recent.slice(0, RECENT_SHOWN).map((each) => recentRow(each)))
    list.push(...fresh.slice(0, FOUND_SHOWN).map(foundRow))
    if (found?.state === "scanning" && fresh.length === 0) list.push({ id: "found:scanning", section: localWords("On this Mac"), icon: FolderGit2Icon, title: localWords("Looking for projects on this Mac…") })
    const guardedNames = (paths: string[]) => paths.map((path) => path.split("/").at(-1)).join(", ")
    if (found?.refused.length) list.push({ id: "found:refused", section: localWords("On this Mac"), icon: ShieldIcon, title: `macOS keeps Mako out of ${guardedNames(found.refused)}`, detail: "Privacy & Security › Files and Folders", keys: ["↩"], keysLabel: "Open settings", run: openPrivacySettings })
    else if (found?.skipped.length) list.push({ id: "found:skipped", section: localWords("On this Mac"), icon: FolderSearchIcon, title: `Also look in ${guardedNames(found.skipped)}`, detail: "macOS may ask first", run: scanGuardedFolders })
    list.push(...startRows)
    return list
  })()

  const selectable = rows.filter((row) => row.run)
  const selected = selectable[Math.min(cursor, Math.max(selectable.length - 1, 0))]

  function toMode(next: OpenProjectMode) {
    setMode(next)
    setQuery("")
    focusField()
  }

  async function begin(repository: string, folder: string) {
    const id = await startClone(repository, folder)
    setShownClone(id)
  }

  async function cloneElsewhere(repository: string) {
    const folder = await chooseCloneFolder()
    if (folder) await begin(repository, folder)
    focusField()
  }

  async function make(path: string, git: boolean) {
    setCreating({ path })
    const error = await createProject(path, git)
    if (error) setCreating({ path, error })
  }

  async function createElsewhere(project: string) {
    const folder = await chooseCloneFolder()
    if (folder) await make(`${folder}/${project}`, true)
  }

  const move = (delta: number) => {
    if (!selectable.length) return
    const at = Math.min(cursor, selectable.length - 1)
    const next = (at + delta + selectable.length) % selectable.length
    setCursor(next)
    const id = selectable[next]?.id
    if (id) listRef.current?.querySelector(`[data-row-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" })
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (clone?.state.kind === "cloning") {
        cancelClone(clone.id)
        dropClone(clone.id)
        setShownClone(undefined)
        return
      }
      if (clone) {
        dropClone(clone.id)
        setShownClone(undefined)
        return
      }
      if (mode !== "open") return toMode("open")
      closeProjectPalette()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      move(event.key === "ArrowDown" ? 1 : -1)
      return
    }
    if (event.key === "Tab" && parsed.kind === "path") {
      event.preventDefault()
      const target = selected?.complete ? selected : selectable.find((row) => row.complete)
      if (target?.complete) setQuery(target.complete)
      return
    }
    if ((event.key === "o" || event.key === "O") && (event.metaKey || event.ctrlKey) && event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      chooseInFinder(parsed.kind === "path" && listing?.exact.kind === "folder" ? listing.exact.path : listing?.folder)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      if (!selected?.run) return
      selected.run({ meta: event.metaKey || event.ctrlKey, alt: event.altKey })
    }
  }

  let lastSection = ""
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Open project"
      data-open-project
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/55 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeProjectPalette()
      }}
    >
      <div onKeyDown={onKeyDown} className="overlay-panel w-full max-w-dialog overflow-hidden">
        <div className="flex h-11 items-center gap-2.5 border-b border-hairline px-3.5">
          {mode === "clone" ? <DownloadIcon className="size-3.5 shrink-0 text-faint" aria-hidden /> : mode === "create" ? <FolderPlusIcon className="size-3.5 shrink-0 text-faint" aria-hidden /> : <FolderOpenIcon className="size-3.5 shrink-0 text-faint" aria-hidden />}
          <input
            autoFocus
            data-open-project-field
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={PLACEHOLDER[mode]}
            aria-label={PLACEHOLDER[mode]}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-full min-w-0 flex-1 bg-transparent text-ui placeholder:text-faint focus:outline-none"
          />
          {mode !== "open" ? (
            <button type="button" onClick={() => toMode("open")} className="pressable flex shrink-0 items-center gap-1.5 text-label text-faint hover:text-foreground">
              All projects <Keys keys={["Esc"]} />
            </button>
          ) : null}
        </div>
        <div ref={listRef} className="max-h-[min(32rem,62vh)] overflow-y-auto overscroll-contain p-1.5" data-open-project-rows>
          {rows.map((row) => {
            const header = row.section !== lastSection ? row.section : null
            lastSection = row.section
            const isSelected = row === selected
            const Icon = row.icon
            return (
              <div key={row.id}>
                {header ? <Eyebrow className="px-1.5 pt-2 pb-1">{header}</Eyebrow> : null}
                <div
                  role={row.run ? "button" : undefined}
                  tabIndex={-1}
                  data-row-id={row.id}
                  data-selected={isSelected || undefined}
                  onMouseMove={() => {
                    const at = selectable.indexOf(row)
                    if (at >= 0 && at !== cursor) setCursor(at)
                  }}
                  onClick={(event) => {
                    row.run?.({ meta: event.metaKey || event.ctrlKey, alt: event.altKey })
                    focusField()
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-2 text-left",
                    row.wrap ? "py-2" : "h-8",
                    row.run ? "cursor-default" : "text-faint",
                    isSelected && "bg-fill-selected"
                  )}
                >
                  <Icon className={cn("size-3.5 shrink-0", isSelected ? "text-foreground/80" : "text-faint", row.wrap && "self-start mt-0.5")} aria-hidden />
                  <span className={cn("flex min-w-0 flex-1 items-baseline gap-2", row.wrap && "flex-col gap-0.5")}>
                    <span className={cn("text-ui", row.wrap ? "w-full leading-snug" : "shrink-0 truncate max-w-[60%]", row.run || row.progress !== undefined ? "text-foreground" : "text-faint")}>{row.title}</span>
                    {row.progress !== undefined ? (
                      // A clone under way: Git's step and how far along, under the line that says what's cloning.
                      <span className="flex w-full items-center gap-2.5 pt-1">
                        <Meter value={Math.max(row.progress ?? 0, 2) / 100} className="flex-1" />
                        <span className="tabular shrink-0 text-label text-faint">{[row.detail, row.progress === null ? undefined : `${row.progress}%`].filter(Boolean).join(" · ")}</span>
                      </span>
                    ) : row.detail ? <span className="min-w-0 truncate text-label text-faint">{row.detail}</span> : null}
                  </span>
                  {row.badge ? <span className="shrink-0 text-label text-faint">{row.badge}</span> : null}
                  {row.keys && (isSelected || !row.keysLabel || row.progress !== undefined) ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-label text-faint">
                      {row.keysLabel ? <span>{row.keysLabel}</span> : null}
                      <Keys keys={row.keys} />
                    </span>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

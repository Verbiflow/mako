import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronRightIcon, FolderIcon, SearchIcon, XIcon } from "lucide-react"
import { Blank } from "@/components/ui/kit"
import type { FileFindHit } from "@mako/host/contracts/file-index"
import { FileIcon } from "@/components/ui/file-icon"
import { fileTreeModels, type FileTreeRow, type FilesSource } from "@/state/file-tree"
import { cn } from "@/lib/utils"
import { TEXT_FIRST, useFileSearch, type FileSearchState } from "./use-file-search"

/**
 * A folder's files: the tree, and one field that finds files by name as it's typed and lines inside them a moment
 * later. Keyboard first: arrows walk the rows (right opens a folder, left closes it or goes up), Enter opens, and
 * typing anywhere in it searches. Shared by the desk's Files panel and the web app's, each with its own source.
 */
export interface FilesBrowserProps {
  source: FilesSource
  /** Open folders, by path. */
  open: ReadonlySet<string>
  onOpenChange: (open: string[]) => void
  /** The file on screen, which the tree shows open to. */
  active?: string
  onOpenFile: (path: string, line?: number) => void
  /** Middle-click: put the file in the message instead. */
  onMention?: (path: string) => void
  /** Bumped when the files may have changed (Git said so, the agent worked): the open folders are read again. */
  changed?: unknown
  /** Taller rows for fingers. */
  touch?: boolean
  autoFocus?: boolean
  className?: string
}

type ResultRow =
  | { kind: "heading"; key: string; label: string; detail?: string }
  | { kind: "name"; key: string; path: string; at: number[] }
  | { kind: "match-file"; key: string; path: string; lines: number }
  | { kind: "match-line"; key: string; path: string; line: number; text: string }
  | { kind: "action"; key: string; label: string; run: () => void }
  | { kind: "note"; key: string; text: string }

type Row = FileTreeRow | ResultRow

const selectable = (row: Row) => row.kind === "dir" || row.kind === "file" || row.kind === "more" || row.kind === "name" || row.kind === "match-line" || row.kind === "match-file" || row.kind === "action"

export function FilesBrowser({ source, open, onOpenChange, active, onOpenFile, onMention, changed, touch, autoFocus, className }: FilesBrowserProps) {
  const model = useMemo(() => fileTreeModels.of(source), [source])
  const revision = useSyncExternalStore(
    useCallback((listener: () => void) => model.subscribe(listener), [model]),
    () => model.revision
  )
  const tree = model.state
  const [query, setQuery] = useState("")
  const search = useFileSearch(source, query)
  const searching = query.trim().length > 0
  const field = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState<string>()
  const rowHeight = touch ? 40 : 26

  useEffect(() => model.refresh(), [model, changed])
  useEffect(() => {
    const again = () => model.refresh()
    window.addEventListener("focus", again)
    return () => window.removeEventListener("focus", again)
  }, [model])

  const treeRows = useMemo(() => {
    void revision
    return model.rows(open)
  }, [model, open, revision])
  const resultRows = useMemo(() => (searching ? resultsOf(search, query) : []), [search, query, searching])
  const rows: Row[] = searching ? resultRows : treeRows

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => (rows[index]?.kind === "heading" ? rowHeight + 6 : rowHeight),
    overscan: 16,
    getItemKey: (index) => rows[index]?.key ?? index,
  })

  // The cursor stays on its row as rows come and go; with no row of its own it's the first that can hold it.
  const cursorIndex = useMemo(() => {
    const at = cursor ? rows.findIndex((row) => row.key === cursor) : -1
    return at >= 0 ? at : searching ? rows.findIndex(selectable) : -1
  }, [cursor, rows, searching])

  // A file opened elsewhere (a link, a tab) is shown in the tree: its folders open, its row in view.
  const revealed = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!active || revealed.current === active || active.startsWith("/")) return
    revealed.current = active
    const folders: string[] = []
    for (let slash = active.indexOf("/"); slash >= 0; slash = active.indexOf("/", slash + 1)) folders.push(active.slice(0, slash))
    if (folders.some((folder) => !open.has(folder))) onOpenChange([...new Set([...open, ...folders])])
    setCursor(active)
  }, [active, open, onOpenChange])
  const shown = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    if (searching || !active || shown.current === `${active}\0${revision}`) return
    const index = treeRows.findIndex((row) => row.kind === "file" && row.path === active)
    if (index < 0) return
    shown.current = `${active}\0${revision}`
    virtualizer.scrollToIndex(index, { align: "auto" })
  }, [active, treeRows, searching, revision, virtualizer])

  const toggle = useCallback(
    (path: string, to?: boolean) => {
      const isOpen = open.has(path)
      const next = to ?? !isOpen
      if (next === isOpen) return
      if (!next) model.close(path)
      onOpenChange(next ? [...open, path] : [...open].filter((each) => each !== path && !each.startsWith(`${path}/`)))
    },
    [model, open, onOpenChange]
  )

  const activate = useCallback(
    (row: Row) => {
      if (row.kind === "dir") toggle(row.path)
      else if (row.kind === "file" || row.kind === "name" || row.kind === "match-file") onOpenFile(row.path)
      else if (row.kind === "match-line") onOpenFile(row.path, row.line)
      else if (row.kind === "more") model.showAll(row.path)
      else if (row.kind === "action") row.run()
    },
    [toggle, onOpenFile, model]
  )

  const move = (by: number) => {
    let at = cursorIndex
    for (let step = 0; step < rows.length; step += 1) {
      at = Math.max(0, Math.min(rows.length - 1, at + by))
      const row = rows[at]
      if (row && selectable(row)) break
      if (at === 0 || at === rows.length - 1) break
    }
    const row = rows[at]
    if (!row || !selectable(row)) return
    setCursor(row.key)
    virtualizer.scrollToIndex(at, { align: "auto" })
  }

  const onKeys = (event: KeyboardEvent<HTMLElement>, fromField: boolean) => {
    const row = rows[cursorIndex]
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault()
      move(1)
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault()
      move(-1)
    } else if (event.key === "Enter") {
      if (!row) return
      event.preventDefault()
      activate(row)
    } else if (event.key === "Escape") {
      if (!query) return
      event.preventDefault()
      setQuery("")
      setCursor(undefined)
      if (!fromField) field.current?.focus()
    } else if (!fromField && (event.key === "ArrowRight" || event.key === "ArrowLeft") && row?.kind === "dir") {
      event.preventDefault()
      if (event.key === "ArrowRight") {
        if (!row.open) toggle(row.path, true)
        else move(1)
      } else if (row.open) toggle(row.path, false)
      else parentOf(row)
    } else if (!fromField && event.key === "ArrowLeft" && row) {
      event.preventDefault()
      parentOf(row)
    } else if (!fromField && (event.key === "Home" || event.key === "End")) {
      event.preventDefault()
      const at = event.key === "Home" ? rows.findIndex(selectable) : rows.findLastIndex(selectable)
      const target = rows[at]
      if (target) {
        setCursor(target.key)
        virtualizer.scrollToIndex(at, { align: "auto" })
      }
    } else if (!fromField && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== " ") {
      // Typing in the tree searches it.
      event.preventDefault()
      setQuery((current) => current + event.key)
      field.current?.focus()
    } else if (!fromField && event.key === " " && row) {
      event.preventDefault()
      activate(row)
    }
  }

  const parentOf = (row: Row) => {
    if (!("depth" in row) || row.depth === 0) return
    const index = rows.indexOf(row)
    for (let at = index - 1; at >= 0; at -= 1) {
      const above = rows[at]
      if (above?.kind === "dir" && above.depth === row.depth - 1) {
        setCursor(above.key)
        virtualizer.scrollToIndex(at, { align: "auto" })
        return
      }
    }
  }

  const placeholder = tree.status === "ready" && tree.total > 0 ? `Search ${tree.total.toLocaleString()} ${tree.total === 1 ? "file" : "files"}` : "Search files"

  return (
    <div className={cn("files-browser flex h-full min-h-0 flex-col", touch && "files-touch", className)}>
      <div className="shrink-0 px-2 pt-2 pb-1.5">
        <label className="files-field relative flex h-8 items-center gap-2 bg-raised px-2.5 text-faint focus-within:text-muted-foreground">
          <SearchIcon className="size-3.5 shrink-0" aria-hidden />
          <input
            ref={field}
            value={query}
            autoFocus={autoFocus}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            enterKeyHint="go"
            onChange={(event) => {
              setQuery(event.target.value)
              setCursor(undefined)
            }}
            onKeyDown={(event) => onKeys(event, true)}
            placeholder={placeholder}
            aria-label="Search files by name and contents"
            aria-controls="files-rows"
            className="h-full min-w-0 flex-1 bg-transparent text-ui text-foreground placeholder:text-faint focus:outline-none"
          />
          {query ? (
            <button type="button" aria-label="Clear the search" onClick={() => { setQuery(""); field.current?.focus() }} className="pressable -mr-1 flex size-6 items-center justify-center text-faint hover:text-foreground">
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </label>
      </div>

      {!searching && tree.status === "failed" ? (
        <Blank icon={<FolderIcon />} title="Couldn't read this folder's files" body={tree.error} action={<button type="button" className="pressable text-ui text-foreground underline decoration-hairline underline-offset-3" onClick={() => model.retry()}>Try again</button>} />
      ) : !searching && tree.status === "ready" && tree.total === 0 ? (
        <Blank icon={<FolderIcon />} title="No files here yet" body="Files Git ignores, and build and dependency folders, aren't listed." />
      ) : (
        <div
          ref={scroller}
          id="files-rows"
          role={searching ? "listbox" : "tree"}
          aria-label={searching ? "Search results" : "Files"}
          aria-activedescendant={rows[cursorIndex] ? rowId(rows[cursorIndex]!.key) : undefined}
          tabIndex={0}
          onKeyDown={(event) => onKeys(event, false)}
          className="files-rows min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-3 focus:outline-none"
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              if (!row) return null
              return (
                <div key={item.key} className="absolute top-0 left-0 w-full" style={{ height: item.size, transform: `translate3d(0, ${item.start}px, 0)` }}>
                  <RowView
                    row={row}
                    query={query}
                    cursor={item.index === cursorIndex}
                    active={"path" in row && row.kind !== "dir" && row.kind !== "more" && row.kind !== "pending" && row.path === active}
                    onPress={activate}
                    onPoint={setCursor}
                    onMention={onMention}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

const rowId = (key: string) => `files-row-${encodeURIComponent(key)}`

/** The rows a search shows: names first, then the lines inside files. */
function resultsOf(search: FileSearchState, query: string): ResultRow[] {
  const rows: ResultRow[] = []
  const names = search.names
  const term = query.trim()
  // No name matching is said only when there's nothing else to say: a word that's only inside files shows just those.
  if (names && (names.hits.length || term.length < 2)) {
    rows.push({ kind: "heading", key: "h:names", label: "Files", detail: names.total ? (names.total > names.hits.length ? `${names.hits.length} of ${names.total.toLocaleString()}` : `${names.total.toLocaleString()}`) : undefined })
    if (!names.hits.length) rows.push({ kind: "note", key: "n:names", text: "No file names match" })
    for (const hit of names.hits) rows.push({ kind: "name", key: `n:${hit.path}`, path: hit.path, at: hit.at })
  }
  if (term.length < 2) return rows
  const text = search.text
  const lines = text?.total ?? 0
  rows.push({ kind: "heading", key: "h:text", label: "In files", detail: text && !text.error && lines ? `${text.more ? `${lines.toLocaleString()}+` : lines.toLocaleString()} ${lines === 1 ? "line" : "lines"} in ${text.files.length.toLocaleString()} ${text.files.length === 1 ? "file" : "files"}` : undefined })
  if (!text) {
    rows.push({ kind: "note", key: "t:wait", text: "Searching…" })
    return rows
  }
  if (text.error) {
    rows.push({ kind: "note", key: "t:error", text: text.error })
    return rows
  }
  if (!text.files.length) rows.push({ kind: "note", key: "t:none", text: search.searching ? "Searching…" : "No lines match" })
  for (const file of text.files) {
    rows.push({ kind: "match-file", key: `f:${file.path}`, path: file.path, lines: file.lines.length + file.more })
    for (const line of file.lines) rows.push({ kind: "match-line", key: `l:${file.path}:${line.line}`, path: file.path, line: line.line, text: line.text })
  }
  if (text.more && text.total >= TEXT_FIRST) rows.push({ kind: "action", key: "t:all", label: "Show every match", run: search.showAllText })
  return rows
}

const RowView = memo(function RowView({ row, query, cursor, active, onPress, onPoint, onMention }: {
  row: Row
  query: string
  cursor: boolean
  active: boolean
  onPress: (row: Row) => void
  onPoint: (key: string) => void
  onMention?: (path: string) => void
}) {
  if (row.kind === "heading")
    return (
      <div className="flex h-full items-end gap-2 px-2 pb-1 text-label">
        <span className="font-medium text-muted-foreground">{row.label}</span>
        {row.detail ? <span className="tabular text-faint">{row.detail}</span> : null}
      </div>
    )
  if (row.kind === "note") return <div className="flex h-full items-center px-2 text-label text-faint">{row.text}</div>
  if (row.kind === "pending")
    return (
      <div className="flex h-full items-center" style={indent(row.depth)} aria-hidden>
        <span className="files-pending ml-5 h-1.5 w-24 bg-fill-selected" />
      </div>
    )
  const path = "path" in row ? row.path : undefined
  return (
    <button
      type="button"
      id={rowId(row.key)}
      role={row.kind === "dir" || row.kind === "file" ? "treeitem" : "option"}
      aria-expanded={row.kind === "dir" ? row.open : undefined}
      aria-selected={cursor}
      tabIndex={-1}
      data-cursor={cursor || undefined}
      data-active={active || undefined}
      title={row.kind === "file" || row.kind === "name" || row.kind === "match-file" ? path : undefined}
      onClick={() => {
        onPoint(row.key)
        onPress(row)
      }}
      onAuxClick={(event) => {
        if (event.button === 1 && path && row.kind !== "more" && row.kind !== "dir") onMention?.(path)
      }}
      style={"depth" in row ? indent(row.depth) : undefined}
      className="files-row flex h-full w-full items-center gap-1.5 pr-2 text-left"
    >
      {row.kind === "dir" ? (
        <>
          <ChevronRightIcon aria-hidden className={cn("files-chevron size-3 shrink-0 text-faint", row.open && "rotate-90")} />
          <FileIcon path={row.path} folder open={row.open} className="size-3.5 text-faint" />
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="min-w-0 truncate text-ui text-foreground/90">{row.name}</span>
            {row.changed ? <Changed /> : null}
          </span>
        </>
      ) : row.kind === "file" ? (
        <>
          <span className="w-3 shrink-0" />
          <FileIcon path={row.path} className="files-icon size-3.5" />
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="files-name min-w-0 truncate text-ui">{row.name}</span>
            {row.changed ? <Changed /> : null}
          </span>
        </>
      ) : row.kind === "more" ? (
        <>
          <span className="w-3 shrink-0" />
          <span className="truncate text-label text-muted-foreground">Show {row.count.toLocaleString()} more</span>
        </>
      ) : row.kind === "name" ? (
        <NameHit hit={row} />
      ) : row.kind === "match-file" ? (
        <>
          <FileIcon path={row.path} className="files-icon size-3.5" />
          <PathLabel path={row.path} />
          <span className="tabular shrink-0 text-label text-faint">{row.lines}</span>
        </>
      ) : row.kind === "match-line" ? (
        <>
          <span className="tabular w-12 shrink-0 pr-1.5 text-right font-mono text-code text-faint">{row.line}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-code text-muted-foreground">
            <Marked text={row.text.trimStart()} term={query.trim()} />
          </span>
        </>
      ) : (
        <span className="pl-2 text-label font-medium text-muted-foreground">{row.label}</span>
      )}
    </button>
  )
})

/** Changed in Git: a dot beside the name in the text's own ink, as the Changes panel and the rail mark a change. */
function Changed() {
  return <span aria-label="Changed" className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
}

/** Depth is indentation, capped so a deep tree can't squeeze the name to nothing. */
function indent(depth: number) {
  return { paddingLeft: 6 + Math.min(depth, 10) * 12 }
}

function PathLabel({ path }: { path: string }) {
  const slash = path.lastIndexOf("/")
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span className="files-name shrink-0 truncate text-ui">{path.slice(slash + 1)}</span>
      {/* rtl truncates from the left, keeping the nearest folders. */}
      <span className="min-w-0 truncate text-label text-faint" dir="rtl">
        <bdi>{slash > 0 ? path.slice(0, slash) : ""}</bdi>
      </span>
    </span>
  )
}

/** A file found by name: the name, its folder after it, and the letters the query matched in each. */
function NameHit({ hit }: { hit: Pick<FileFindHit, "path" | "at"> }) {
  const slash = hit.path.lastIndexOf("/")
  const at = new Set(hit.at)
  return (
    <>
      <FileIcon path={hit.path} className="files-icon size-3.5" />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="files-name shrink-0 truncate text-ui">
          <Letters text={hit.path} from={slash + 1} to={hit.path.length} at={at} />
        </span>
        <span className="min-w-0 truncate text-label text-faint" dir="rtl">
          <bdi>{slash > 0 ? <Letters text={hit.path} from={0} to={slash} at={at} /> : null}</bdi>
        </span>
      </span>
    </>
  )
}

function Letters({ text, from, to, at }: { text: string; from: number; to: number; at: ReadonlySet<number> }) {
  const parts: ReactNode[] = []
  let run = ""
  let hit = false
  for (let index = from; index < to; index += 1) {
    const isHit = at.has(index)
    if (isHit !== hit && run) {
      parts.push(hit ? <mark key={index} className="files-hit">{run}</mark> : run)
      run = ""
    }
    hit = isHit
    run += text[index]
  }
  if (run) parts.push(hit ? <mark key="end" className="files-hit">{run}</mark> : run)
  return <>{parts}</>
}

/** A matching line with each match of the term marked; a long line starts a little before its first match. */
function Marked({ text: line, term }: { text: string; term: string }) {
  if (!term) return <>{line}</>
  const needle = term.toLowerCase()
  const first = line.toLowerCase().indexOf(needle)
  const text = first > 28 ? `…${line.slice(first - 18)}` : line
  const lower = text.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  for (let at = lower.indexOf(needle); at >= 0 && parts.length < 40; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={at} className="files-hit">{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
  }
  parts.push(text.slice(from))
  return <>{parts}</>
}

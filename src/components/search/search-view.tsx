import { memo, useCallback, useEffect, useMemo, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Blank, IconAction } from "@/components/ui/kit"
import { search, useSearch } from "@/state/search"
import { viewer } from "@/state/viewer"
import { actions } from "@/state/session"
import { formatRelative, workspaceName } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { FileMatches, SearchResults, ThreadMatches } from "@/lib/types"
import {
  CaseSensitiveIcon,
  MessagesSquareIcon,
  RegexIcon,
  SearchIcon,
  WholeWordIcon,
  XIcon,
} from "lucide-react"
import { Shimmer } from "@/components/ui/shimmer"

const ROW_HEIGHT = 22
const HEADER_HEIGHT = 26

/**
 * Search across the project and every conversation in it.
 *
 * One box for both, because in this app they are one question: "where did that
 * retry logic go" is answered either by the file that holds it or by the
 * conversation where you decided it, and having to pick which before you
 * search is the small tax that stops people searching at all.
 *
 * Results are one flat virtualized list rather than nested scrollers. A repo
 * search can be thousands of rows, and a scroller inside a scroller is the
 * fastest way to make a long result set unnavigable.
 */
export function SearchView() {
  const open = useSearch((state) => state.open)
  const query = useSearch((state) => state.query)
  const options = useSearch((state) => state.options)
  const results = useSearch((state) => state.results)
  const running = useSearch((state) => state.running)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const take = () => {
      input.current?.focus()
      input.current?.select()
    }
    take()
    // Coming back to the window puts focus on the document, not on whatever
    // had it before — so with this open, typing did nothing until you clicked.
    window.addEventListener("focus", take)
    return () => window.removeEventListener("focus", take)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        search.close()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  if (!open) return null

  return (
    <div className="absolute inset-0 z-30 flex min-h-0 flex-col bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-2.5">
        <SearchIcon className="size-3.5 shrink-0 text-faint" />
        <input
          ref={input}
          value={query}
          onChange={(event) => search.setQuery(event.target.value)}
          placeholder="Search this project and its conversations"
          className="h-8 min-w-0 flex-1 bg-transparent text-ui placeholder:text-faint focus:outline-none"
        />
        <Toggle
          label="Match case"
          on={Boolean(options.caseSensitive)}
          onClick={() => search.toggle("caseSensitive")}
        >
          <CaseSensitiveIcon />
        </Toggle>
        <Toggle
          label="Whole word"
          on={Boolean(options.wholeWord)}
          onClick={() => search.toggle("wholeWord")}
        >
          <WholeWordIcon />
        </Toggle>
        <Toggle
          label="Regular expression"
          on={Boolean(options.regex)}
          onClick={() => search.toggle("regex")}
        >
          <RegexIcon />
        </Toggle>
        <Toggle
          label="Include conversations"
          on={options.threads !== false}
          onClick={() => search.toggle("threads")}
        >
          <MessagesSquareIcon />
        </Toggle>
        <IconAction label="Close" keys={["Esc"]} size="xs" onClick={() => search.close()}>
          <XIcon />
        </IconAction>
      </div>

      <Summary results={results} running={running} query={query} />

      <div className="min-h-0 flex-1">
        {results?.error ? (
          <p className="p-4 text-ui text-removed">{results.error}</p>
        ) : results && results.total > 0 ? (
          <Results results={results} />
        ) : query.trim().length < 2 ? (
          <Blank
            icon={<SearchIcon />}
            title="Search everything here"
            body="File contents in this project, and every message in every conversation about it. Two characters is enough to start."
          />
        ) : running ? null : (
          <Blank
            icon={<SearchIcon />}
            title="No matches"
            body={`Nothing in this project or its conversations contains “${query.trim()}”.`}
          />
        )}
      </div>
    </div>
  )
}

/** What was found, how long it took, and what was left out. */
function Summary({
  results,
  running,
  query,
}: {
  results?: SearchResults
  running: boolean
  query: string
}) {
  if (query.trim().length < 2) return null
  return (
    <div className="flex h-6 shrink-0 items-center gap-2 border-b border-hairline px-3 text-label text-faint">
      {running ? (
        <span className=""><Shimmer text="Searching…" /></span>
      ) : results ? (
        <>
          <span className="tabular">
            {results.total} {results.total === 1 ? "match" : "matches"}
          </span>
          {results.files.length > 0 ? (
            <span className="tabular">
              in {results.files.length} {results.files.length === 1 ? "file" : "files"}
            </span>
          ) : null}
          {results.threads.length > 0 ? (
            <span className="tabular">
              and {results.threads.length}{" "}
              {results.threads.length === 1 ? "conversation" : "conversations"}
            </span>
          ) : null}
          <span className="tabular ml-auto">{results.elapsed}ms</span>
          {results.truncated ? (
            <span className="text-caution">capped — narrow the query for the rest</span>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

type Row =
  | { kind: "file-header"; key: string; file: FileMatches }
  | { kind: "file-line"; key: string; path: string; line: number; text: string }
  | { kind: "thread-header"; key: string; thread: ThreadMatches }
  | { kind: "thread-line"; key: string; path: string; role: string; text: string }

function Results({ results }: { results: SearchResults }) {
  const scroller = useRef<HTMLDivElement>(null)

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = []
    for (const file of results.files) {
      list.push({ kind: "file-header", key: `f:${file.path}`, file })
      for (const line of file.lines) {
        list.push({
          kind: "file-line",
          key: `f:${file.path}:${line.line}`,
          path: file.path,
          line: line.line,
          text: line.text,
        })
      }
    }
    for (const thread of results.threads) {
      list.push({ kind: "thread-header", key: `t:${thread.path}`, thread })
      thread.lines.forEach((line, index) => {
        list.push({
          kind: "thread-line",
          key: `t:${thread.path}:${index}`,
          path: thread.path,
          role: line.role,
          text: line.text,
        })
      })
    }
    return list
  }, [results])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) =>
      rows[index]?.kind.endsWith("header") ? HEADER_HEIGHT : ROW_HEIGHT,
    overscan: 16,
    getItemKey: (index) => rows[index]?.key ?? index,
  })

  const openFile = useCallback((path: string, line: number) => {
    void viewer.open(path, line)
    search.close()
  }, [])

  const openThread = useCallback((path: string) => {
    void actions.openSession(path)
    search.close()
  }, [])

  return (
    <div ref={scroller} className="h-full overflow-y-auto overscroll-contain px-1.5 py-1.5">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (!row) return null
          return (
            <div
              key={item.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: item.size,
                transform: `translate3d(0, ${item.start}px, 0)`,
              }}
            >
              {row.kind === "file-header" ? (
                <FileHeader file={row.file} />
              ) : row.kind === "file-line" ? (
                <LineRow
                  text={row.text}
                  query={results.query}
                  gutter={String(row.line)}
                  onOpen={() => openFile(row.path, row.line)}
                />
              ) : row.kind === "thread-header" ? (
                <ThreadHeader thread={row.thread} />
              ) : (
                <LineRow
                  text={row.text}
                  query={results.query}
                  gutter={row.role === "user" ? "you" : row.role === "assistant" ? "agent" : row.role}
                  onOpen={() => openThread(row.path)}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const FileHeader = memo(function FileHeader({ file }: { file: FileMatches }) {
  const name = file.path.split("/").at(-1) ?? file.path
  const dir = file.path.slice(0, Math.max(0, file.path.length - name.length - 1))
  return (
    <div className="flex h-full items-center gap-1.5 px-1.5">
      <span className="shrink-0 truncate text-ui font-medium text-foreground/90">{name}</span>
      <span className="min-w-0 flex-1 truncate text-label text-faint">{dir}</span>
      <span className="tabular shrink-0 text-label text-faint">
        {file.lines.length + file.more}
        {file.more > 0 ? "+" : ""}
      </span>
    </div>
  )
})

const ThreadHeader = memo(function ThreadHeader({ thread }: { thread: ThreadMatches }) {
  return (
    <div className="flex h-full items-center gap-1.5 px-1.5">
      <MessagesSquareIcon className="size-3 shrink-0 text-faint" />
      <span className="truncate text-ui font-medium text-foreground/90">{thread.title}</span>
      <span className="min-w-0 flex-1 truncate text-label text-faint">
        {workspaceName(thread.cwd)}
      </span>
      <span className="tabular shrink-0 text-label text-faint">
        {formatRelative(thread.modified)}
      </span>
    </div>
  )
})

const LineRow = memo(function LineRow({
  text,
  query,
  gutter,
  onOpen,
}: {
  text: string
  query: string
  gutter: string
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex h-full w-full items-center gap-2 rounded px-1.5 text-left",
        "transition-colors duration-100 hover:bg-fill-hover"
      )}
    >
      <span className="tabular w-10 shrink-0 text-right text-label text-faint/70">{gutter}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-label text-foreground/75">
        <Highlight text={text} query={query} />
      </span>
    </button>
  )
})

/**
 * The matched term, marked.
 *
 * Case-insensitive and literal, matching the default search. A regex search
 * shows its rows unmarked rather than re-running the pattern per row — the
 * line is the answer, and a wrong highlight is worse than none.
 */
function Highlight({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return [{ text, hit: false }]
    const out: Array<{ text: string; hit: boolean }> = []
    const lower = text.toLowerCase()
    let cursor = 0
    for (let guard = 0; guard < 40; guard += 1) {
      const at = lower.indexOf(needle, cursor)
      if (at < 0) break
      if (at > cursor) out.push({ text: text.slice(cursor, at), hit: false })
      out.push({ text: text.slice(at, at + needle.length), hit: true })
      cursor = at + needle.length
    }
    out.push({ text: text.slice(cursor), hit: false })
    return out
  }, [query, text])

  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-[2px] bg-foreground/20 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </>
  )
}

function Toggle({
  label,
  on,
  onClick,
  children,
}: {
  label: string
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <IconAction label={label} size="xs" data-on={on || undefined} onClick={onClick}>
      {children}
    </IconAction>
  )
}

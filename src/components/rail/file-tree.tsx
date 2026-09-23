import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Blank } from "@/components/ui/kit"
import { buildWorkspaceTree, pathToOpenKeys, type WorkspaceRow } from "@/lib/workspace-tree"
import { rank } from "@/lib/fuzzy"
import { retryWorkspaceFiles, useWorkspaceFiles } from "@/state/files"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { viewer, useViewer } from "@/state/viewer"
import { cn } from "@/lib/utils"
import { fileName } from "@/lib/format"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon, SearchIcon, XIcon } from "lucide-react"

const ROW_HEIGHT = 24
/** Filtering is a flat list of matches, so it needs a ceiling of its own. */
const MAX_MATCHES = 400

/**
 * The project, as a tree.
 *
 * Sits beside the thread list rather than in the inspector, because it answers
 * the same kind of question the thread list does — "what is in this project?"
 * — and because the inspector is about *this conversation*, which a file
 * browser is not.
 *
 * Typing switches it from a tree to a ranked flat list of matches. That is the
 * right shape for a filter: a tree with the misses hidden still makes you read
 * folder rows to find the file, and the whole point of typing is that you
 * already know the name.
 */
export function FileTree() {
  const focus = useWorkspaceFocus()
  const [query, setQuery] = useState("")
  const deferred = useDeferredValue(query)
  const fileIndex = useWorkspaceFiles(focus.ready, focus.cwd)
  const { files } = fileIndex
  const openDirs = usePrefs((prefs) => prefs.openDirs)
  const active = useViewer((state) => state.path)
  const scroller = useRef<HTMLDivElement>(null)

  const rows = useMemo<WorkspaceRow[]>(() => {
    const needle = deferred.trim()
    if (!needle) return buildWorkspaceTree(files, new Set(openDirs))
    return rank(files, needle, (file) => file.path)
      .slice(0, MAX_MATCHES)
      .map((file) => ({
        kind: "file" as const,
        key: file.path,
        // Under a filter the file name alone is ambiguous — three `index.ts`
        // rows tell you nothing — so matches show their path.
        label: file.path,
        depth: 0,
        path: file.path,
        changed: Boolean(file.changed),
      }))
  }, [deferred, files, openDirs])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
  })

  const toggle = useCallback((key: string) => {
    // Read through the store so the callback stays stable and rows keep their
    // memoization while the tree is being opened up.
    const current = prefsStore.get().openDirs
    setPref("openDirs", current.includes(key) ? current.filter((k) => k !== key) : [...current, key])
  }, [])

  const open = useCallback((path: string) => void viewer.open(path), [])

  /** Jump to a file and leave the tree opened to it, so context is not lost. */
  const reveal = useCallback(
    (path: string) => {
      const keys = pathToOpenKeys(files, path)
      if (keys.length > 0) {
        const current = prefsStore.get().openDirs
        setPref("openDirs", [...new Set([...current, ...keys])])
      }
      setQuery("")
    },
    [files]
  )

  if (!focus.ready) {
    return (
      <Blank
        icon={<FolderIcon />}
        title="Loading project"
        body={focus.cwd ?? "Resolving the focused conversation workspace."}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("")
              if (event.key === "Enter") {
                const first = rows.find((row) => row.kind === "file")
                if (first && first.kind === "file") {
                  open(first.path)
                  reveal(first.path)
                }
              }
            }}
            placeholder="Find a file"
            className="h-7 w-full rounded-md bg-raised pr-7 pl-7 text-ui placeholder:text-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-border"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-faint hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {rows.length === 0 ? (
        <Blank
          icon={<FolderIcon />}
          action={
            fileIndex.kind === "failed" && focus.cwd ? (
              <button
                type="button"
                className="pressable text-ui"
                onClick={() => {
                  if (focus.cwd) retryWorkspaceFiles(focus.cwd)
                }}
              >
                Retry
              </button>
            ) : undefined
          }
          title={
            fileIndex.kind === "loading"
              ? "Reading the project…"
              : fileIndex.kind === "failed"
                ? "Could not read project files"
                : query
                  ? "No matching files"
                  : "No files"
          }
          body={
            fileIndex.kind === "failed"
              ? fileIndex.error
              : fileIndex.kind === "loading"
                ? undefined
                : query
                  ? "Try part of the file name, or a folder along its path."
                  : "This folder has no files the agent can see. Ignored paths are not listed."
          }
        />
      ) : (
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-3"
        >
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
                  {row.kind === "dir" ? (
                    <DirRow row={row} onToggle={toggle} />
                  ) : (
                    <FileRow
                      row={row}
                      active={row.path === active}
                      onOpen={open}
                      onReveal={query ? reveal : undefined}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {query && rows.length >= MAX_MATCHES ? (
        <p className="shrink-0 px-3 pb-2 text-label text-faint">
          First {MAX_MATCHES} matches. Keep typing to narrow it.
        </p>
      ) : null}
    </div>
  )
}

/** Depth is indentation, capped so a deep tree cannot squeeze the name to nothing. */
function indent(depth: number) {
  return { paddingLeft: 4 + Math.min(depth, 8) * 10 }
}

const DirRow = memo(function DirRow({
  row,
  onToggle,
}: {
  row: Extract<WorkspaceRow, { kind: "dir" }>
  onToggle: (key: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(row.key)}
      style={indent(row.depth)}
      className={cn(
        "group flex h-full w-full items-center gap-1.5 rounded pr-1.5 text-left",
        "transition-colors duration-100 hover:bg-fill-hover"
      )}
    >
      <ChevronRightIcon
        className={cn(
          "size-3 shrink-0 text-faint transition-transform duration-150",
          row.open && "rotate-90"
        )}
      />
      {row.open ? (
        <FolderOpenIcon className="size-3.5 shrink-0 text-faint" />
      ) : (
        <FolderIcon className="size-3.5 shrink-0 text-faint" />
      )}
      <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">{row.label}</span>
      <span className="tabular shrink-0 text-label text-faint opacity-0 transition-opacity duration-100 group-hover:opacity-100">
        {row.files}
      </span>
    </button>
  )
})

const FileRow = memo(function FileRow({
  row,
  active,
  onOpen,
  onReveal,
}: {
  row: Extract<WorkspaceRow, { kind: "file" }>
  active: boolean
  onOpen: (path: string) => void
  onReveal?: (path: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onOpen(row.path)
        onReveal?.(row.path)
      }}
      onAuxClick={(event) => {
        // Middle-click puts it in the composer instead of opening it — the
        // other reason you go looking for a file in an agent app.
        if (event.button === 1) {
          window.dispatchEvent(new CustomEvent("mako:insert", { detail: `@${row.path} ` }))
        }
      }}
      title={row.path}
      data-active={active || undefined}
      style={indent(row.depth)}
      className={cn(
        "flex h-full w-full items-center gap-1.5 rounded pr-1.5 text-left",
        "transition-colors duration-100 hover:bg-fill-hover data-active:bg-raised"
      )}
    >
      <span className="w-3 shrink-0" />
      <FileIcon className="size-3.5 shrink-0 text-faint/70" />
      {onReveal ? (
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className={cn("shrink-0 truncate text-ui", active ? "font-medium text-foreground" : "text-foreground/85")}>
            {fileName(row.path)}
          </span>
          {/* rtl truncates from the left, keeping the nearest folders. */}
          <span className="min-w-0 truncate text-label text-faint" dir="rtl">
            <bdi>{row.path.slice(0, Math.max(0, row.path.lastIndexOf("/")))}</bdi>
          </span>
        </span>
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-ui",
            active ? "font-medium text-foreground" : "text-foreground/80"
          )}
        >
          {row.label}
        </span>
      )}
      {row.changed ? (
        <span aria-label="Changed" className="size-1 shrink-0 rounded-full bg-caution" />
      ) : null}
    </button>
  )
})

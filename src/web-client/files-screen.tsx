import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeftIcon, BookOpenIcon, Code2Icon, XIcon } from "lucide-react"
import type { FileContents } from "@mako/host/contracts/git-workspace-search"
import { FilesBrowser } from "@/components/files/files-browser"
import { FileIcon } from "@/components/ui/file-icon"
import { getMako } from "@/lib/bridge"
import { fileKind } from "@/lib/file-kinds"
import { useAcp } from "@/state/acp-state"
import { conversationFiles } from "@/state/file-tree"
import { closeFiles, readInFiles, type FilesOpen } from "./files-open"
import { WebSideRail } from "./side-rail"
import { LazyBoundary } from "@/components/ui/lazy-boundary"
import { LazyFailed } from "@/components/ui/lazy-failed"

const FileView = lazy(() => import("@/components/viewer/file-view").then((module) => ({ default: module.FileView })))

/** Agent work arrives in batches several times a second; the folders on screen are read again at most this often. */
const REREAD_MS = 2_000

export function FilesScreen({ open, touch }: { open: FilesOpen; touch: boolean }) {
  const source = useMemo(() => conversationFiles(open.conversation), [open.conversation])
  const [folders, setFolders] = useState<string[]>([])
  const openSet = useMemo(() => new Set(folders), [folders])
  const changed = useRereads(open.conversation)
  const onOpenFile = useCallback((path: string, line?: number) => readInFiles(path, line), [])
  return (
    <div className="rv-screen">
      {!touch ? <WebSideRail active="files" conversation={open.conversation} /> : null}
      {!touch && !open.path ? null : <div className="rv-bar">
        {open.path ? (
          <button type="button" aria-label="Back to the files" className="web-icon-button" onClick={() => readInFiles(undefined)}>
            <ArrowLeftIcon className="size-5" />
          </button>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-2 px-2">
          {open.path ? <FileIcon path={open.path} className="size-3.5 text-faint" /> : null}
          <span className="truncate text-title font-semibold">{open.path ? open.path.slice(open.path.lastIndexOf("/") + 1) : "Files"}</span>
        </span>
        {touch ? (
          <button type="button" aria-label="Close Files" className="web-icon-button" onClick={closeFiles}>
            <XIcon className="size-5" />
          </button>
        ) : null}
      </div>}
      {/* The tree stays mounted under a file, so Back lands where it was. */}
      <div className={open.path ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <FilesBrowser source={source} open={openSet} onOpenChange={setFolders} active={open.path} onOpenFile={onOpenFile} changed={changed} touch={touch} />
      </div>
      {open.path ? <FileReader key={open.path} conversation={open.conversation} path={open.path} line={open.line} /> : null}
    </div>
  )
}

/** A number that moves when the conversation does (its agent working), at most every `REREAD_MS`. */
function useRereads(conversation: string): number {
  const state = useAcp((acp) => acp.conversations[conversation])
  const [tick, setTick] = useState(0)
  const last = useRef(0)
  useEffect(() => {
    const wait = Math.max(0, last.current + REREAD_MS - Date.now())
    const timer = setTimeout(() => {
      last.current = Date.now()
      setTick((count) => count + 1)
    }, wait)
    return () => clearTimeout(timer)
  }, [state])
  return tick
}

function FileReader({ conversation, path, line }: { conversation: string; path: string; line?: number }) {
  const [file, setFile] = useState<FileContents>()
  const [error, setError] = useState<string>()
  const rich = /\.(?:md|markdown|mdx|csv|tsv)$/i.test(path)
  const [mode, setMode] = useState<"source" | "preview">(rich ? "preview" : "source")
  useEffect(() => {
    let current = true
    getMako().readLiveFile(conversation, path).then(
      (read) => {
        if (current) setFile(read)
      },
      (failure: Error) => {
        if (current) setError(failure.message)
      }
    )
    return () => {
      current = false
    }
  }, [conversation, path])
  const slash = path.lastIndexOf("/")
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-label text-faint">
        <span className="min-w-0 flex-1 truncate" dir="rtl">
          <bdi>{slash > 0 ? path.slice(0, slash) : ""}</bdi>
        </span>
        <span className="shrink-0">{fileKind(path).label}</span>
        {rich ? (
          <button type="button" className="pressable flex h-7 items-center gap-1 px-1.5 text-muted-foreground" aria-pressed={mode === "preview"} onClick={() => setMode(mode === "preview" ? "source" : "preview")}>
            {mode === "preview" ? <Code2Icon className="size-3.5" /> : <BookOpenIcon className="size-3.5" />}
            {mode === "preview" ? "Source" : "Preview"}
          </button>
        ) : null}
      </div>
      <div className="rv-scroll overflow-x-auto">
        {error ? (
          <p className="p-4 text-ui text-negative">{error}</p>
        ) : !file ? (
          <p className="p-4 text-ui text-faint">Reading {path.slice(slash + 1)}…</p>
        ) : (
          <LazyBoundary fallback={() => <LazyFailed what="The file" />}>
            <Suspense fallback={<p className="p-4 text-ui text-faint">Opening…</p>}>
              <FileView file={file} line={line} mode={mode} />
            </Suspense>
          </LazyBoundary>
        )}
      </div>
    </div>
  )
}

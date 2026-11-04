import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowLeftIcon, BookOpenIcon, Code2Icon, XIcon } from "lucide-react"
import type { FileContents } from "@mako/host/contracts/git-workspace-search"
import { FilesBrowser } from "@/components/files/files-browser"
import { FileIcon } from "@/components/ui/file-icon"
import { getMako } from "@/lib/bridge"
import { fileKind } from "@/lib/file-kinds"
import { activeAcp, useAcp } from "@/state/acp"
import { conversationFiles } from "@/state/file-tree"
import { EASE_OUT, EASE_SWIFT, reducedMotion } from "./motion"
import { closeFiles, followFilesHistory, leftFiles, readInFiles, useFilesOpen, type FilesOpen } from "./files-open"
import { leftReview, reviewOpenStore } from "./review-open"
import type { WebForm } from "./route"

const FileView = lazy(() => import("@/components/viewer/file-view").then((module) => ({ default: module.FileView })))

/** Agent work arrives in batches several times a second; the folders on screen are read again at most this often. */
const REREAD_MS = 2_000

/**
 * Files on the web: a conversation's folder, browsed and searched on the computer that runs it, where Changes goes
 * (over the Thread on a phone, beside the transcript on a laptop), and a file read there with its source highlighted.
 * The two take turns: opening one puts the other away.
 */
export function FilesLayer({ form, place }: { form: WebForm; place: string | undefined }) {
  const open = useFilesOpen((state) => state.open)
  useEffect(() => followFilesHistory(), [])
  useEffect(() => reviewOpenStore.subscribe(() => {
    if (reviewOpenStore.get().open) leftFiles()
  }), [])
  useEffect(() => {
    if (open) leftReview()
  }, [open])
  const was = useRef(place)
  useEffect(() => {
    if (was.current !== place) leftFiles()
    was.current = place
  }, [place])
  const onScreen = useAcp((state) => activeAcp(state)?.key)
  useEffect(() => {
    if (open && onScreen && onScreen !== open.conversation) leftFiles()
  }, [open, onScreen])

  const [shown, setShown] = useState<FilesOpen | null>(open)
  if (open && shown !== open) setShown(open)
  const layer = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    const element = layer.current
    const isOpen = open !== null
    if (isOpen === wasOpen.current || !element) return
    wasOpen.current = isOpen
    const slide = form === "phone" && !reducedMotion()
    const away: Keyframe = slide ? { transform: "translate3d(100%, 0, 0)" } : { opacity: 0, transform: form === "desk" ? "translate3d(12px, 0, 0)" : "none" }
    const here: Keyframe = slide ? { transform: "none" } : { opacity: 1, transform: "none" }
    if (isOpen) {
      element.animate([away, here], { duration: slide ? 240 : 160, easing: EASE_OUT })
      return
    }
    const gone = () => setShown(null)
    void element.animate([here, away], { duration: slide ? 180 : 120, easing: EASE_SWIFT, fill: "forwards" }).finished.then(gone, gone)
  }, [open, form])
  if (!shown) return null
  return (
    <div ref={layer} className="rv-layer" data-form={form} data-closing={open ? undefined : ""}>
      <FilesScreen key={shown.conversation} open={shown} touch={form !== "desk"} />
    </div>
  )
}

function FilesScreen({ open, touch }: { open: FilesOpen; touch: boolean }) {
  const source = useMemo(() => conversationFiles(open.conversation), [open.conversation])
  const [folders, setFolders] = useState<string[]>([])
  const openSet = useMemo(() => new Set(folders), [folders])
  const changed = useRereads(open.conversation)
  const onOpenFile = useCallback((path: string, line?: number) => readInFiles(path, line), [])
  return (
    <div className="rv-screen">
      <div className="rv-bar">
        {open.path ? (
          <button type="button" aria-label="Back to the files" className="web-icon-button" onClick={() => readInFiles(undefined)}>
            <ArrowLeftIcon className="size-5" />
          </button>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-2 px-2">
          {open.path ? <FileIcon path={open.path} className="text-faint" /> : null}
          <span className="truncate text-title font-semibold">{open.path ? open.path.slice(open.path.lastIndexOf("/") + 1) : "Files"}</span>
        </span>
        <button type="button" aria-label="Close Files" className="web-icon-button" onClick={closeFiles}>
          <XIcon className="size-5" />
        </button>
      </div>
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
          <p className="p-4 text-ui text-removed">{error}</p>
        ) : !file ? (
          <p className="p-4 text-ui text-faint">Reading {path.slice(slash + 1)}…</p>
        ) : (
          <Suspense fallback={<p className="p-4 text-ui text-faint">Opening…</p>}>
            <FileView file={file} line={line} mode={mode} />
          </Suspense>
        )}
      </div>
    </div>
  )
}

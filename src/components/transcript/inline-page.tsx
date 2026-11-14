import { lazy, Suspense, useState, type CSSProperties, type ReactNode, type RefObject } from "react"
import { ArrowUpRightIcon, CodeIcon, ExpandIcon } from "lucide-react"
import { PAGE_MIN_HEIGHT } from "@mako/host/contracts/page-frame"
import { Skeleton } from "@/components/ui/skeleton"
import { HtmlFrame, type PageReport } from "@/components/viewer/html-frame"
import type { FileContents } from "@/lib/types"
import { cn } from "@/lib/utils"
import { MediaUnavailable } from "./media-preview"
import { LazyBoundary } from "@/components/ui/lazy-boundary"
import { LazyFailed } from "@/components/ui/lazy-failed"

const RichFilePreview = lazy(() => import("@/components/viewer/rich-file-preview"))

/** The tallest a page draws in the conversation before "Show all"; past it, it fades out. */
const PAGE_CAP = 560
/** The tallest a page grows when shown whole: a page that grows with its frame stops here. */
const PAGE_WHOLE_MAX = 12_000
/** A page's place before it reports a height, and when it can't (one too large to be fitted): a picture's default shape, never past the cap. */
const PAGE_UNMEASURED: CSSProperties = { aspectRatio: "16 / 10", maxHeight: PAGE_CAP }

/**
 * What pages last reported, by path: a page drawn again (scrolled back into
 * view, its conversation reopened) holds its place from the first frame
 * instead of growing into it.
 */
const reports = new Map<string, PageReport>()
const REPORTS_KEPT = 500

function remember(path: string, report: PageReport) {
  reports.delete(path)
  reports.set(path, report)
  if (reports.size > REPORTS_KEPT) reports.delete(reports.keys().next().value!)
}

/**
 * A page the agent made, drawn as the page: no card and no tabs, a hairline
 * round it, as tall as its content between `PAGE_MIN_HEIGHT` and
 * `PAGE_CAP`, where it fades and offers the rest. Until it reports a
 * height, and when it never does, it holds a picture's default shape. A
 * page that loaded and draws nothing (an app's `index.html`, whose script
 * runs only in its app) says so in a quiet box of the minimum height, the
 * page still under it in case it draws later. Its name and what can be done
 * with it (its source, full screen, a tab of its own) wait on hover, like a
 * picture's.
 */
export function InlinePage({ hostRef, path, name, file, error, openPath, onExpand, onOpen, onRetry }: {
  hostRef: RefObject<HTMLDivElement | null>
  /** What `data-inline-file-preview` names: the spelling the answer used. */
  path: string
  name: string
  /** The page as read, with the URL it is served at; absent until it is read. */
  file?: FileContents
  error?: string
  /** A path a tab can open; absent for a page that came as bytes. */
  openPath?: string
  onExpand(): void
  onOpen(): void
  onRetry(): void
}) {
  const [report, setReport] = useState(() => reports.get(path))
  const [whole, setWhole] = useState(false)
  const [source, setSource] = useState(false)
  if (error)
    return (
      <div ref={hostRef} data-inline-file-preview={path} className="not-prose my-3">
        <MediaUnavailable name={name} reason={error} onRetry={onRetry} />
      </div>
    )
  const empty = report !== undefined && !report.drawn && report.settled
  const content = report?.drawn ? Math.max(report.height, PAGE_MIN_HEIGHT) : undefined
  const long = content !== undefined && content > PAGE_CAP
  const size: CSSProperties = empty ? { height: PAGE_MIN_HEIGHT } : content === undefined ? PAGE_UNMEASURED : { height: Math.min(content, whole ? PAGE_WHOLE_MAX : PAGE_CAP) }
  const heard = (next: PageReport) => {
    remember(path, next)
    setReport(next)
  }
  return (
    <div ref={hostRef} data-inline-file-preview={path} data-inline-page={empty ? "empty" : content === undefined ? "unmeasured" : "measured"} className="group/page not-prose relative my-3 w-full">
      {source && file ? (
        <div className="media-surface overflow-hidden border border-hairline bg-surface">
          <LazyBoundary fallback={() => <LazyFailed what="The page" />}>
            <Suspense fallback={<Skeleton className="block h-40 w-full" />}>
              <RichFilePreview file={file} mode="source" name={name} />
            </Suspense>
          </LazyBoundary>
        </div>
      ) : (
        <div data-page-frame className={cn("media-surface relative overflow-hidden border border-hairline", long && !whole && "page-fade")} style={size}>
          {file?.previewUrl ? (
            <HtmlFrame url={file.previewUrl} name={name} fill onReport={heard} />
          ) : (
            <Skeleton className="block size-full rounded-none" />
          )}
          {empty ? (
            <div data-page-empty className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-shell px-6 text-center">
              <span className="max-w-full truncate text-ui text-muted-foreground">{name} shows nothing on its own</span>
              <span className="max-w-full truncate text-label text-faint">It may need the app or server it was made for.</span>
            </div>
          ) : null}
        </div>
      )}
      {empty && !source ? null : (
        <span className="media-control pointer-events-none absolute top-2 left-2 max-w-[calc(100%-8rem)] truncate px-2 py-1 text-label opacity-0 transition-opacity duration-150 group-hover/page:opacity-100">{name}</span>
      )}
      {file ? (
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/page:opacity-100 focus-within:opacity-100">
          {file.contents ? (
            <PageButton label={source ? `Show ${name} as a page` : `Show the source of ${name}`} title={source ? "Page" : "Source"} pressed={source} onClick={() => setSource(!source)}>
              <CodeIcon className="size-3.5" />
            </PageButton>
          ) : null}
          <PageButton label={`Show ${name} full screen`} title="Full screen" onClick={onExpand}>
            <ExpandIcon className="size-3.5" />
          </PageButton>
          {openPath ? (
            <PageButton label={`Open ${name} in a tab`} title="Open" onClick={onOpen}>
              <ArrowUpRightIcon className="size-3.5" />
            </PageButton>
          ) : null}
        </div>
      ) : null}
      {long && !source ? (
        <button type="button" aria-expanded={whole} onClick={() => setWhole(!whole)} className="media-control pressable absolute bottom-2 left-1/2 -translate-x-1/2 px-2.5 py-1 text-label">
          {whole ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  )
}

function PageButton({ label, title, pressed, onClick, children }: { label: string; title: string; pressed?: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={title} aria-pressed={pressed} onClick={onClick} className="media-control pressable grid size-7 place-items-center aria-pressed:bg-popover">
      {children}
    </button>
  )
}

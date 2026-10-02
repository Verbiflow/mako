import {
  Fragment,
  lazy,
  memo,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type RefObject,
} from "react"
import { Action, IconAction } from "@/components/ui/kit"
import { Divider } from "@/components/shell/divider"
import { GitDiffPreviewView } from "@/components/inspector/git-diff-preview"
import { GitLoading } from "@/components/inspector/git-loading"
import { StageStrip } from "@/components/stage/stage-strip"
import { PlanDocumentView } from "@/components/viewer/plan-view"
import { TranscriptControls } from "@/components/viewer/transcript-controls"
import { engageWorkbenchPane, focusWorkbenchPane } from "@/state/session-panes"
import { useTabDrag, type DropSide } from "@/state/tab-drag"
import { desktop } from "@/state/desktop"
import { prefsStore } from "@/state/prefs"
import {
  AGENT_TAB_ID,
  viewer,
  useViewer,
  type PaneSession,
  type ViewerDocument,
  type ViewerPane,
} from "@/state/viewer"
import { cn } from "@/lib/utils"
import {
  AtSignIcon,
  BookOpenIcon,
  Code2Icon,
  ExternalLinkIcon,
  RefreshCwIcon,
} from "lucide-react"

/** The highlighting runtime is heavy and nobody has opened a file yet. */
const View = lazy(() =>
  import("@/components/viewer/file-view").then((module) => ({
    default: module.FileView,
  }))
)

/** One pane's chat: its Session while unfocused, and whether it has the composer. */
export interface AgentSurfaceProps {
  session?: PaneSession
  composer: boolean
}

/**
 * The central workbench for the agent session, files, and diffs.
 *
 * Tabs belong to a pane, transient previews are replaced by the state layer,
 * and the optional second pane writes drag sizes directly to its DOM node so
 * highlighting and Markdown do not re-render on every pointer move.
 */
export function FileViewer({
  AgentSurface,
  className,
  style,
  workspaceRef,
}: {
  AgentSurface: ComponentType<AgentSurfaceProps>
  className?: string
  style?: CSSProperties
  workspaceRef: RefObject<HTMLDivElement | null>
}) {
  const path = useViewer((state) => state.path)
  const documents = useViewer((state) => state.documents)
  const panes = useViewer((state) => state.panes)
  const focusedPaneId = useViewer((state) => state.focusedPaneId)
  const split = useViewer((state) => state.split)
  const [firstPanes] = useState(() => new Set(panes.map((pane) => pane.id)))
  const panesHost = useRef<HTMLDivElement>(null)
  const secondary = useRef<HTMLDivElement>(null)
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const [paneWidth, setPaneWidth] = useState(420)
  const [paneHeight, setPaneHeight] = useState(320)

  useEffect(() => {
    if (!path) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        viewer.showAgent()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [path])

  useEffect(() => {
    const node = panesHost.current
    if (!node) return
    const update = (width: number, height: number) => {
      setBounds((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height }
      )
    }
    const initial = node.getBoundingClientRect()
    update(initial.width, initial.height)
    const observer = new ResizeObserver((entries) => {
      const content = entries[0]?.contentRect
      if (!content) return
      if (resizeTimer.current) clearTimeout(resizeTimer.current)
      resizeTimer.current = setTimeout(
        () => update(content.width, content.height),
        80
      )
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
      if (resizeTimer.current) clearTimeout(resizeTimer.current)
    }
  }, [])

  const hasSecondPane = panes.length === 2
  const horizontal = split === "right"
  const holdsAgent = (pane: ViewerPane) => pane.tabIds.includes(AGENT_TAB_ID)
  const chats = panes.filter(holdsAgent).length
  // The composer sits in the focused chat, or else in the chat showing the
  // active conversation, so there is always exactly one.
  const composerPane =
    panes.find((pane) => pane.id === focusedPaneId && holdsAgent(pane)) ??
    panes.find((pane) => holdsAgent(pane) && !pane.session) ??
    panes.find(holdsAgent)
  const closable = (pane: ViewerPane) => hasSecondPane && (chats === 2 || !holdsAgent(pane))

  const secondMin = horizontal
    ? Math.min(240, bounds.width / 2)
    : Math.min(180, bounds.height / 2)
  const secondMax = horizontal
    ? Math.max(secondMin, bounds.width - secondMin - 1)
    : Math.max(secondMin, bounds.height - secondMin - 1)
  const secondSize = clamp(
    horizontal ? paneWidth : paneHeight,
    secondMin,
    secondMax
  )

  return (
    <div
      ref={workspaceRef}
      style={style}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface",
        className
      )}
    >
      <div
        ref={panesHost}
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          hasSecondPane && !horizontal && "flex-col"
        )}
      >
        {panes.map((pane, index) => {
          const second = index === 1
          // A pane made by a split grows in once, as it mounts.
          const arrived = !firstPanes.has(pane.id)
          const from = horizontal ? (second ? "right" : "left") : second ? "down" : "up"
          return (
            <Fragment key={pane.id}>
              {second ? (
                <Divider
                  side={horizontal ? "right" : "bottom"}
                  size={secondSize}
                  min={secondMin}
                  max={secondMax}
                  onResize={(next) => {
                    if (!secondary.current) return
                    if (horizontal) secondary.current.style.width = `${next}px`
                    else secondary.current.style.height = `${next}px`
                  }}
                  onCommit={(next) => {
                    if (horizontal) setPaneWidth(next)
                    else setPaneHeight(next)
                  }}
                />
              ) : null}
              <div
                ref={second ? secondary : undefined}
                style={second ? (horizontal ? { width: secondSize } : { height: secondSize }) : undefined}
                data-arrive-from={arrived ? from : undefined}
                className={cn(
                  "flex min-h-0 min-w-0",
                  second ? "shrink-0" : "flex-1",
                  arrived && "workbench-pane-arrive"
                )}
              >
                <FilePane
                  AgentSurface={AgentSurface}
                  pane={pane}
                  documents={documents}
                  focused={focusedPaneId === pane.id}
                  composer={composerPane?.id === pane.id}
                  canClosePane={closable(pane)}
                />
              </div>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

const FilePane = memo(function FilePane({
  AgentSurface,
  pane,
  documents,
  focused,
  composer,
  canClosePane,
}: {
  AgentSurface: ComponentType<AgentSurfaceProps>
  pane: ViewerPane
  documents: Record<string, ViewerDocument>
  focused: boolean
  composer: boolean
  canClosePane: boolean
}) {
  const agent = pane.activeId === AGENT_TAB_ID
  const hasAgent = pane.tabIds.includes(AGENT_TAB_ID)
  const document = pane.activeId ? documents[pane.activeId] : undefined
  const chat = useRef<HTMLDivElement>(null)
  // The first press in a chat without focus only moves focus there. Its
  // buttons act on the active conversation, which is still the other one.
  const swallow = useRef(false)

  return (
    <section
      aria-label="Workbench pane"
      data-pane-id={pane.id}
      onPointerDownCapture={(event) => {
        const target = event.target instanceof Element ? event.target : null
        const resting = Boolean(target?.closest("[data-pane-reply]"))
        swallow.current =
          !focused && agent && Boolean(pane.session) && Boolean(target && chat.current?.contains(target)) && !resting
        if (resting) engageWorkbenchPane(pane.id)
        else focusWorkbenchPane(pane.id)
      }}
      className={cn(
        "workbench-pane relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface",
        focused && "ring-1 ring-border ring-inset"
      )}
    >
      <StageStrip paneId={pane.id} canClosePane={canClosePane} />
      {hasAgent ? (
        <div
          ref={chat}
          onClickCapture={(event) => {
            if (!swallow.current) return
            swallow.current = false
            event.preventDefault()
            event.stopPropagation()
          }}
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col",
            !agent && "hidden"
          )}
        >
          <AgentSurface session={pane.session} composer={composer} />
        </div>
      ) : null}
      {!agent && document ? <DocumentView document={document} /> : null}
      <PaneDropOverlay paneId={pane.id} />
    </section>
  )
})

const DROP_LABELS = {
  left: "Open on the left",
  right: "Open to the right",
  up: "Open above",
  down: "Open below",
  center: "Open here",
} satisfies Record<DropSide, string>

/** Where a dragged tab would land in this pane, while one is dragged. */
function PaneDropOverlay({ paneId }: { paneId: string }) {
  const dragging = useTabDrag((state) => state.drag !== null)
  const side = useTabDrag((state) => (state.zone?.paneId === paneId ? state.zone.side : null))
  const panes = useViewer((state) => state.panes.length)
  if (!dragging) return null
  return (
    <div className="pane-drop" data-side={side ?? undefined} aria-hidden>
      <div className="pane-drop-plate">{side ? (panes > 1 ? "Show here" : DROP_LABELS[side]) : null}</div>
    </div>
  )
}

function DocumentView({ document }: { document: ViewerDocument }) {
  if (document.kind === "plan" && document.plan) return <PlanDocumentView document={document} of={document.plan} />
  const previewable =
    document.kind === "transcript" ||
    (document.kind === "file" &&
      (hasRichPreview(document.path) || Boolean(document.file?.artifactPreview)))
  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline px-2">
        {document.kind === "transcript" ? (
          <TranscriptControls document={document} />
        ) : (
          <span
            className="min-w-0 flex-1 truncate px-1 font-mono text-label text-faint"
            title={document.path}
          >
            {document.path}
          </span>
        )}
        {document.file?.truncated ? (
          <span className="shrink-0 rounded bg-raised px-1.5 py-px text-label text-caution">
            first 2 MB
          </span>
        ) : null}
        {previewable ? (
          <Action
            size="xs"
            aria-pressed={document.renderMode === "preview"}
            onClick={() =>
              viewer.setRenderMode(
                document.id,
                document.renderMode === "preview" ? "source" : "preview"
              )
            }
          >
            {document.renderMode === "preview" ? (
              <Code2Icon />
            ) : (
              <BookOpenIcon />
            )}
            <span>
              {document.renderMode === "preview" ? "Source" : "Preview"}
            </span>
          </Action>
        ) : null}
        {document.kind === "file" ? (
          <>
            <IconAction
              label="Mention this file in the composer"
              size="xs"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("mako:insert", {
                    detail: `@${document.path} `,
                  })
                )
              }}
            >
              <AtSignIcon />
            </IconAction>
            <IconAction
              label="Re-read from disk"
              size="xs"
              onClick={() => viewer.refresh(document.path)}
            >
              <RefreshCwIcon />
            </IconAction>
            <IconAction
              label="Open in your editor"
              size="xs"
              onClick={() =>
                void desktop.openInEditor(
                  document.path,
                  prefsStore.get().externalEditor
                )
              }
            >
              <ExternalLinkIcon />
            </IconAction>
          </>
        ) : null}
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto",
          document.loading && "opacity-60"
        )}
      >
        {document.error ? (
          <p className="p-4 text-ui text-removed">{document.error}</p>
        ) : document.loading ? (
          <GitLoading kind="diff" label={`Reading ${document.kind === "transcript" ? document.title : document.path}`} />
        ) : document.kind === "diff" && document.diff ? (
          <CenterDiff diffs={document.diff.diffs} note={document.diff.note} />
        ) : (document.kind === "file" || document.kind === "transcript") && document.file ? (
          <Suspense fallback={<GitLoading kind="diff" label={`Opening ${document.title}`} />}>
            <View
              file={document.file}
              line={document.line}
              mode={document.renderMode}
            />
          </Suspense>
        ) : (
          <GitLoading kind="diff" label={`Reading ${document.path}`} />
        )}
      </div>
    </>
  )
}

/**
 * The diff engine, loaded only when a diff actually opens here — it carries
 * a syntax-highlighting runtime that has no business in the boot path.
 */
const LazyDiff = lazy(async () => {
  const { MultiFileDiff, Virtualizer } = await import("@pierre/diffs/react")
  function Center({
    diffs,
    note,
  }: {
    diffs: import("@/lib/types").GitDiff[]
    note?: string
  }) {
    const showable = diffs.filter(
      (diff) => !diff.binary && (diff.preview || diff.oldFile || diff.newFile)
    )
    if (showable.length === 0) {
      return (
        <p className="p-4 text-ui text-faint">No text content to compare.</p>
      )
    }
    return (
      <Virtualizer className="min-h-full">
        {showable.map((diff) => diff.preview ? <GitDiffPreviewView key={diff.path} path={diff.path} preview={diff.preview} /> : (
          <MultiFileDiff
            key={diff.path}
            {...(diff.oldFile && diff.newFile
              ? { oldFile: diff.oldFile, newFile: diff.newFile }
              : diff.newFile
                ? { oldFile: null, newFile: diff.newFile }
                : { oldFile: diff.oldFile!, newFile: null })}
            options={{
              diffStyle: "split",
            }}
          />
        ))}
        {note ? <p className="p-3 text-label text-faint">{note}</p> : null}
      </Virtualizer>
    )
  }
  return { default: Center }
})

function CenterDiff({
  diffs,
  note,
}: {
  diffs: import("@/lib/types").GitDiff[]
  note?: string
}) {
  return (
    <Suspense fallback={<GitLoading kind="diff" label="Loading diff" />}>
      <LazyDiff diffs={diffs} note={note} />
    </Suspense>
  )
}

function hasRichPreview(path: string) {
  return /\.(?:csv|md|markdown|mdx|tsv)$/i.test(path)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

import { memo, useContext, useEffect, useRef, useState } from "react"
import { Composer } from "@/components/composer/composer"
import { Transcript } from "@/components/transcript/transcript"
import { ThreadViewer } from "@/components/viewer/thread-viewer"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { FileViewer, type AgentSurfaceProps } from "@/components/viewer/file-viewer"
import { ConversationScopeContext, TranscriptPaneContext, useConversationScope, type ConversationScope } from "@/state/conversation-scope"
import { closeWorkbenchPane, usePaneScope } from "@/state/session-panes"
import { PaneComposer } from "@/components/composer/pane-composer"
import { SearchView } from "@/components/search/search-view"
import { InboxView } from "@/components/inbox/inbox-view"
import { SessionDraftReceipt } from "@/components/stage/session-draft-receipt"
import { openSessionDraft, useThreadGroups } from "@/state/thread-groups"
import { Divider } from "@/components/shell/divider"
import { ErrorBoundary } from "@/components/shell/error-boundary"
import { useSurfaces } from "@/extend/surfaces"
import { stage, useStage } from "@/state/stage"
import { useTabs } from "@/state/tabs"
import { useThreads } from "@/state/threads"
import { activeAcp, useAcp } from "@/state/acp"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import {
  clampCompanionWidth,
  clampDockHeight,
  COMPANION_DEFAULT,
  COMPANION_MIN_DEFAULT,
  fitsBeside,
} from "@/components/stage/stage-width"
import { cn } from "@/lib/utils"
import { ArrowLeftIcon, MoonIcon } from "lucide-react"
import { QUIET_WORDS } from "@/lib/quiet-device"
import { Action, Blank } from "@/components/ui/kit"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { ChildBreadcrumb } from "@/components/stage/child-view"
import { SideRail } from "@/components/stage/side-rail"
import { useStageLayoutWatch } from "@/components/stage/stage-layout-watch"
import type { TabStage } from "@/state/stage"

/** Identity-stable fallback so the selector never allocates per render. */
const NO_COMPANION: TabStage = {
  companion: null,
  dock: null,
  presentation: "beside",
}

/**
 * The stage: a central tab workbench, the right rail, and an independent dock.
 *
 * The workbench is rendered first, in a stable position, and is *hidden*
 * rather than unmounted when the sidebar covers the stage — opening a panel
 * must never cost the transcript or file tabs their state. This
 * container selects only the stage layout itself; git, meta, and messages
 * belong to the cards, so a token or a git flush cannot re-render the frame.
 */
export function Stage() {
  const activeId = useTabs((state) => state.activeId)
  const tabStage = useStage((state) => state.byTab[activeId] ?? NO_COMPANION)
  const surfaces = useSurfaces()
  const sideSurfaces = surfaces.filter(
    (surface) => surface.placement !== "bottom"
  )
  const surfaceWidths = usePrefs((prefs) => prefs.surfaceWidths)
  const surfaceHeights = usePrefs((prefs) => prefs.surfaceHeights)

  // On first boot, restore the companion you usually work with. Tab ids do
  // not survive a relaunch, so this is the only cross-launch memory needed.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || !activeId) return
    seeded.current = true
    const last = prefsStore.get().lastCompanion
    const remembered = surfaces.find((surface) => surface.id === last)
    if (remembered && remembered.placement !== "bottom")
      stage.open(remembered.id)
    else if (last) setPref("lastCompanion", null)
  }, [activeId, surfaces])

  // The stage measures itself so the clamp and the beside→over degradation
  // are render-time facts, not stored state. Resizes are rare and the two
  // cards are memoized, so the re-render is cheap.
  const stageRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState<
    { width: number; height: number } | undefined
  >(undefined)
  useEffect(() => {
    const node = stageRef.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const bounds = entries[0]?.contentRect
      if (!bounds?.width || !bounds.height) return
      setAvailable((current) =>
        current?.width === bounds.width && current.height === bounds.height
          ? current
          : { width: bounds.width, height: bounds.height }
      )
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useStageLayoutWatch(stageRef)
  const companionRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const workbenchRef = useRef<HTMLDivElement>(null)
  const sideSurface = tabStage.companion
    ? surfaces.find((entry) => entry.id === tabStage.companion)
    : undefined
  const dockSurface = tabStage.dock
    ? surfaces.find((entry) => entry.id === tabStage.dock)
    : undefined
  const min = Math.max(
    COMPANION_MIN_DEFAULT,
    ...sideSurfaces.map((surface) => surface.minWidth ?? 0)
  )
  const width = sideSurface
    ? clampCompanionWidth({
        width: surfaceWidths["right-sidebar"] ?? COMPANION_DEFAULT,
        available: available?.width,
        min,
      })
    : 0
  const dockExpanded = Boolean(dockSurface && tabStage.dockExpanded)
  const dockMin = dockSurface?.minHeight ?? 180
  const dockMax = clampDockHeight({
    height: 9999,
    available: available?.height,
    min: dockMin,
  })
  const dockHeight = dockSurface
    ? clampDockHeight({
        height: surfaceHeights[dockSurface.id] ?? 280,
        available: available?.height,
        min: dockMin,
      })
    : 0
  // A split that cannot afford both minimums renders as "over" without
  // rewriting the stored preference; widening the window restores it.
  const wantsCover = Boolean(
    sideSurface &&
    (tabStage.presentation === "over" || !fitsBeside(available?.width, min))
  )
  const covered = wantsCover

  return (
    <div
      ref={stageRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1",
          dockExpanded && "hidden"
        )}
      >
        <FileViewer
          AgentSurface={AgentSurface}
          workspaceRef={workbenchRef}
          className={cn("flex-1", covered && "hidden")}
        />

        {sideSurface && !covered ? (
          <Divider
            side="right"
            size={width}
            min={min}
            max={available ? Math.max(available.width - 450 - 1, min) : 9999}
            onResize={(next) => {
              if (companionRef.current)
                companionRef.current.style.width = `${next}px`
            }}
            onCommit={(next) =>
              setPref("surfaceWidths", {
                ...prefsStore.get().surfaceWidths,
                ["right-sidebar"]: next,
              })
            }
          />
        ) : null}

        {sideSurface ? (
          <div
            ref={companionRef}
            style={covered ? undefined : { width }}
            className={cn(
              "companion-panel relative flex min-h-0 flex-col overflow-hidden bg-shell",
              covered && "min-w-0 flex-1"
            )}
          >
            {covered ? (
              <div className="flex h-8 shrink-0 items-center justify-end px-2 text-label text-faint">
                <button
                  type="button"
                  onClick={() => stage.close()}
                  className="pressable flex items-center gap-1 px-1.5 py-0.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground"
                >
                  <ArrowLeftIcon className="size-3" />
                  Workbench
                </button>
              </div>
            ) : null}
            <SideRail surfaces={sideSurfaces} activeId={sideSurface.id} />
            <ErrorBoundary key={sideSurface.id} surface={sideSurface.label}>
              <CompanionBody render={sideSurface.render} />
            </ErrorBoundary>
          </div>
        ) : null}
      </div>

      {dockSurface ? (
        <>
          {!dockExpanded ? (
            <Divider
              side="bottom"
              size={dockHeight}
              min={dockMin}
              max={dockMax}
              onResize={(next) => {
                if (dockRef.current) dockRef.current.style.height = `${next}px`
              }}
              onCommit={(next) =>
                setPref("surfaceHeights", {
                  ...prefsStore.get().surfaceHeights,
                  [dockSurface.id]: next,
                })
              }
            />
          ) : null}
          <div
            ref={dockRef}
            style={{ height: dockExpanded ? "100%" : dockHeight }}
            className="terminal-panel relative flex shrink-0 flex-col overflow-hidden bg-surface"
          >
            <ErrorBoundary key={dockSurface.id} surface={dockSurface.label}>
              <CompanionBody render={dockSurface.render} />
            </ErrorBoundary>
          </div>
        </>
      ) : null}
    </div>
  )
}

const AgentSurface = memo(function AgentSurface({ session, composer, paneId }: AgentSurfaceProps) {
  const scope = usePaneScope(session)
  return (
    <main className="agent-surface relative isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {composer ? <ChildBreadcrumb /> : null}
      <ConversationScopeContext.Provider value={scope}>
        <TranscriptPaneContext value={paneId ?? null}>
          <ConversationSurface />
          {!composer && (scope?.kind === "live" || scope?.kind === "history") ? (
            <PaneComposer />
          ) : null}
        </TranscriptPaneContext>
      </ConversationScopeContext.Provider>
      {composer ? (
        <>
          <Composer />
          <SearchView />
          <InboxView />
        </>
      ) : null}
    </main>
  )
})

/** A chat without focus whose Session has no transcript to stream. */
function PaneNotice({ scope }: { scope: Extract<ConversationScope, { kind: "draft" | "missing" }> }) {
  const paneId = useContext(TranscriptPaneContext)
  return (
    <div data-pane-notice={scope.kind} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-ui text-faint">
      <p>
        {scope.kind === "draft"
          ? `New session${scope.title ? ` in “${scope.title}”` : ""}, not sent yet. Click to write it here.`
          : "This session isn't in its thread any more. Close the pane or open another tab."}
      </p>
      {scope.kind === "missing" && paneId ? (
        <Action tone="outline" size="md" onClick={() => closeWorkbenchPane(paneId)}>
          Close pane
        </Action>
      ) : null}
    </div>
  )
}

const CompanionBody = memo(function CompanionBody({
  render: Render,
}: {
  render: React.ComponentType<Record<never, never>>
}) {
  // The computer that has the conversation's folder is off: nothing of it can be read, so every panel says so once
  // rather than each waiting on it.
  const off = useWorkspaceFocus().off
  if (off)
    return (
      <div data-device-off className="h-full">
        <Blank icon={<MoonIcon />} title={`${off} ${QUIET_WORDS}`} body={`Its changes, files and agents show here once ${off} is back. The conversation reads from the copy it keeps in your account.`} />
      </div>
    )
  return <Render />
})

/**
 * The chat column's middle. The composer below is the same for every
 * provider and routes to whoever owns the open conversation.
 */
function ConversationSurface() {
  const scope = useConversationScope()
  const viewingPath = useThreads((state) => state.viewing?.ref.path)
  const viewing = useThreads((state) => Boolean(state.viewing || state.opening))
  const live = useAcp((state) => activeAcp(state) !== null)
  const liveThreadPath = useAcp((state) => activeAcp(state)?.threadPath)
  // A reply from the viewer keeps the viewer — its history plus the echoed
  // prompt — until the provider has opened the session and reported the
  // conversation in full. Swapping to the live panel any earlier showed the
  // new prompt alone until the history arrived a moment later.
  const starting = useAcp((state) => activeAcp(state)?.kind === "starting")
  const draft = useThreadGroups(openSessionDraft)
  if (scope) {
    if (scope.kind === "live") return <AcpPanel />
    if (scope.kind === "history") return <ThreadViewer />
    return <PaneNotice scope={scope} />
  }
  if (
    viewing &&
    (!live || viewingPath !== liveThreadPath || (starting && viewingPath))
  )
    return <ThreadViewer />
  if (live) return <AcpPanel />
  if (draft) return <SessionDraftReceipt draft={draft} />
  return <Transcript />
}

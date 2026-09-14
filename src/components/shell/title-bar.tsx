import { IconAction } from "@/components/ui/kit"
import { Slot } from "@/extend/slot"
import { formatChord } from "@/extend/commands"
import { actions, useSession } from "@/state/session"
import { togglePref, usePrefs } from "@/state/prefs"
import { stage, useStage } from "@/state/stage"
import { useTabs } from "@/state/tabs"
import { TitleBarStatus } from "@/components/shell/title-bar-status"
import { search } from "@/state/search"
import { composerTurnRunning } from "@/lib/composer-action"
import { activeAcp, useAcp } from "@/state/acp"
import { useThreads } from "@/state/threads"
import { cn } from "@/lib/utils"
import {
  PanelLeftIcon,
  PanelRightIcon,
  PlusIcon,
  SearchIcon,
  SquareIcon,
} from "lucide-react"

/**
 * The title strip.
 *
 * Its left segment *is* the sidebar's header — same width, same right border,
 * so the two read as one column rather than as two stacked bars each with
 * their own "new session" button. That duplication was the whole reason the
 * chrome looked wrong: a window has one header, not one per panel.
 *
 * When the rail is closed the segment collapses to just the toggle and the
 * traffic-light inset. The focused tab already names the session, so the
 * bar itself carries no title.
 */
export function TitleBar() {
  const builtinRunning = useSession(
    (state) => state.meta?.isStreaming ?? false
  )
  const livePresent = useAcp((state) => activeAcp(state) !== null)
  const liveRunning = useAcp((state) => {
    const active = activeAcp(state)
    return (
      active?.kind === "starting" || active?.session.status === "running"
    )
  })
  const liveThreadPath = useAcp((state) => activeAcp(state)?.threadPath)
  const viewingPath = useThreads((state) => state.viewing?.ref.path)
  const viewingRunning = useThreads(
    (state) => state.run?.status === "running"
  )
  const streaming = composerTurnRunning({
    builtinRunning,
    livePresent,
    liveRunning,
    liveThreadPath,
    viewingPath,
    viewingRunning,
  })
  const railOpen = usePrefs((prefs) => prefs.railOpen)
  const railWidth = usePrefs((prefs) => prefs.railWidth)
  const activeTab = useTabs((state) => state.activeId)
  const companionOpen = useStage((state) => Boolean(state.byTab[activeTab]?.companion))

  return (
    <header className="drag-region relative flex h-[38px] shrink-0 items-center border-b border-hairline bg-shell pr-2">
      <div
        style={railOpen ? { width: railWidth } : undefined}
        className={cn(
          "flex h-full shrink-0 items-center gap-1 pr-2 pl-[86px]",
          railOpen && "border-r border-hairline"
        )}
      >
        <IconAction
          label={railOpen ? "Hide sessions" : "Show sessions"}
          keys={formatChord("mod+b")}
          data-on={railOpen}
          onClick={() => togglePref("railOpen")}
        >
          <PanelLeftIcon />
        </IconAction>

        <IconAction
          label="New session"
          keys={formatChord("mod+n")}
          onClick={() => void actions.newSession()}
        >
          <PlusIcon />
        </IconAction>

        <Slot name="titlebar.leading" />
      </div>

      <div className="ml-auto flex items-center gap-1 pl-2">
        <TitleBarStatus />
        <Slot name="titlebar.trailing" />
        {streaming ? (
          <IconAction
            label="Stop"
            keys={formatChord("mod+escape")}
            tone="danger"
            onClick={() => void actions.stopCurrentTurn()}
          >
            <SquareIcon />
          </IconAction>
        ) : null}
        {/* Search is the one thing here with no other doorway. The palette
            is Cmd+K, which is the most-known shortcut a desk has and needs no
            glyph arguing for it, and Settings is a row in the identity menu
            the rail's footer already carries. A titlebar is not a toolbar. */}
        <IconAction
          label="Search this project"
          keys={formatChord("mod+shift+f")}
          onClick={() => search.open()}
        >
          <SearchIcon />
        </IconAction>
        <IconAction
          label={companionOpen ? "Hide the right sidebar" : "Show the right sidebar"}
          keys={formatChord("mod+alt+b")}
          data-on={companionOpen}
          onClick={() => stage.toggleCompanion()}
        >
          <PanelRightIcon />
        </IconAction>
      </div>
    </header>
  )
}

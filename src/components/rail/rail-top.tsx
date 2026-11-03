import { memo, useEffect, type ReactNode } from "react"
import { GitPullRequestIcon, InboxIcon, SearchIcon, SquarePenIcon, WorkflowIcon } from "lucide-react"
import { formatChord, keysFor, runCommand, useCommands } from "@/extend/commands"
import { openInbox } from "@/components/inbox/open-inbox"
import { Keys } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import { useAutomations } from "@/state/automations"
import { inboxView, useInboxCount, useInboxRosters, useInboxView } from "@/state/inbox"
import { OPEN_PULLS_LISTED, openPullRequests, refreshOpenPulls, useOpenPulls } from "@/state/open-pulls"
import { usePrefs } from "@/state/prefs"
import { useSession } from "@/state/session"
import { useWindowRoutes } from "@/state/window-routes"

/**
 * The rail's fixed top: New thread, Search, Inbox, Pull requests and
 * Automations, above Pinned and the projects. Five rows, always in this
 * order, none customised. Each reads its own narrow slice, so a token in a
 * Thread or a row changing below repaints none of them; the Inbox's count is
 * a number from the same facts the marks read (`useInboxCount`).
 *
 * A window whose Threads live on another computer (the web desk) has no
 * project of its own to ask GitHub or run automations in, so it shows the
 * first three.
 */
export const RailTop = memo(function RailTop() {
  const routed = useWindowRoutes((state) => state.routes !== null)
  return (
    <nav aria-label="Go to" data-rail-top className="flex shrink-0 flex-col gap-px px-2 pt-1.5 pb-2">
      <CommandRow command="session.new" icon={<SquarePenIcon />} label="New thread" />
      <CommandRow command="view.command-palette" icon={<SearchIcon />} label="Search" />
      <InboxRow />
      {routed ? null : (
        <>
          <PullsRow />
          <AutomationsRow />
        </>
      )}
    </nav>
  )
})

function TopRow({ icon, label, spoken, open, end, onSelect, ...rest }: { icon: ReactNode; label: string; spoken?: string; open?: boolean; end?: ReactNode; onSelect: () => void; "data-rail-top-row": string; "aria-keyshortcuts"?: string; title?: string }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={spoken ?? label}
      aria-current={open ? "page" : undefined}
      data-open={open || undefined}
      className={cn(
        "pressable group/top flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-ui text-foreground/85 transition-colors duration-100 hover:bg-fill-hover hover:text-foreground",
        open && "bg-raised text-foreground hover:bg-raised"
      )}
      {...rest}
    >
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {end}
    </button>
  )
}

/** A row that runs one of the desk's commands, its chord shown on hover. */
function CommandRow({ command, icon, label }: { command: string; icon: ReactNode; label: string }) {
  const registered = useCommands().find((entry) => entry.id === command)
  const overrides = usePrefs((prefs) => prefs.keybindings)
  const chord = registered ? keysFor(registered, overrides) : undefined
  return (
    <TopRow
      data-rail-top-row={command}
      icon={icon}
      label={label}
      aria-keyshortcuts={chord}
      onSelect={() => {
        if (command === "session.new") inboxView.close()
        runCommand(command)
      }}
      end={chord ? (
        <span className="opacity-0 transition-opacity duration-100 group-hover/top:opacity-100 group-focus-visible/top:opacity-100">
          <Keys keys={formatChord(chord)} />
        </span>
      ) : null}
    />
  )
}

function InboxRow() {
  useInboxRosters()
  const count = useInboxCount()
  const open = useInboxView((state) => state.open)
  return (
    <TopRow
      data-rail-top-row="inbox"
      icon={<InboxIcon />}
      label="Inbox"
      spoken={count ? `Inbox, ${count} ${count === 1 ? "needs" : "need"} you` : "Inbox"}
      open={open}
      onSelect={() => (open ? inboxView.close() : openInbox())}
      end={count ? (
        <span data-inbox-count={count} className="tabular flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-caution/15 px-1 text-label font-medium text-caution">
          {count}
        </span>
      ) : null}
    />
  )
}

function PullsRow() {
  const root = useSession((state) => state.git?.root)
  const count = useOpenPulls((state) => (root ? state.byRoot[root]?.count : undefined))
  useEffect(() => {
    refreshOpenPulls(root)
    const again = () => refreshOpenPulls(root)
    window.addEventListener("focus", again)
    return () => window.removeEventListener("focus", again)
  }, [root])
  const shown = count === undefined || count === null ? undefined : count >= OPEN_PULLS_LISTED ? `${OPEN_PULLS_LISTED}+` : String(count)
  return (
    <TopRow
      data-rail-top-row="pulls"
      icon={<GitPullRequestIcon />}
      label="Pull requests"
      title={shown ? `${shown} open on GitHub` : "Open on GitHub"}
      onSelect={() => void openPullRequests(root)}
      end={shown && count ? <span data-pulls-count={count} className="tabular shrink-0 pr-1 text-label text-faint">{shown}</span> : null}
    />
  )
}

function AutomationsRow() {
  const on = useAutomations((state) => state.list.filter((automation) => automation.enabled).length)
  return (
    <TopRow
      data-rail-top-row="automations"
      icon={<WorkflowIcon />}
      label="Automations"
      onSelect={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "automations" }))}
      end={on ? <span data-automations-on={on} className="tabular shrink-0 pr-1 text-label text-faint">{on} on</span> : null}
    />
  )
}

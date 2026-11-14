import { memo, useEffect, type ReactNode } from "react"
import { GitPullRequestIcon, InboxIcon, PackageIcon, SearchIcon, SquarePenIcon, WorkflowIcon } from "lucide-react"
import { formatChord, keysFor, runCommand, useCommands } from "@/extend/commands"
import { openInbox } from "@/components/inbox/open-inbox"
import { RailRow } from "@/components/rail/rail-row"
import { Keys } from "@/components/ui/kit"
import { useAutomations } from "@/state/automations"
import { inboxView, useInboxCount, useInboxRosters, useInboxView } from "@/state/inbox"
import { OPEN_PULLS_LISTED, openPullRequests, refreshOpenPulls, useOpenPulls } from "@/state/open-pulls"
import { usePrefs } from "@/state/prefs"
import { openProjectSetup } from "@/state/project-setup"
import { useSession } from "@/state/session"
import { useWindowRoutes } from "@/state/window-routes"

/**
 * The rail's fixed top: New thread, Search, Inbox, Pull requests, Setup and
 * Automations, above Pinned and the projects. Six rows, always in this
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
          <RailRow
            data-rail-top-row="setup"
            icon={<PackageIcon />}
            label="Setup"
            title="Files, accounts, tools and environments"
            onClick={openProjectSetup}
          />
          <AutomationsRow />
        </>
      )}
    </nav>
  )
})

/** A row that runs one of the desk's commands, its chord shown on hover. */
function CommandRow({ command, icon, label }: { command: string; icon: ReactNode; label: string }) {
  const registered = useCommands().find((entry) => entry.id === command)
  const overrides = usePrefs((prefs) => prefs.keybindings)
  const chord = registered ? keysFor(registered, overrides) : undefined
  return (
    <RailRow
      data-rail-top-row={command}
      icon={icon}
      label={label}
      aria-keyshortcuts={chord}
      onClick={() => {
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
    <RailRow
      data-rail-top-row="inbox"
      icon={<InboxIcon />}
      label="Inbox"
      spoken={count ? `Inbox, ${count} ${count === 1 ? "needs" : "need"} you` : "Inbox"}
      open={open}
      onClick={() => (open ? inboxView.close() : openInbox())}
      end={count ? (
        <span data-inbox-count={count} className="tabular flex h-[18px] min-w-[18px] items-center justify-center bg-attention/15 px-1 text-label font-medium text-attention">
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
    <RailRow
      data-rail-top-row="pulls"
      icon={<GitPullRequestIcon />}
      label="Pull requests"
      title={shown ? `${shown} open on GitHub` : "Open on GitHub"}
      onClick={() => void openPullRequests(root)}
      end={shown && count ? <span data-pulls-count={count} className="tabular shrink-0 pr-1 text-label text-faint">{shown}</span> : null}
    />
  )
}

function AutomationsRow() {
  const on = useAutomations((state) => state.list.filter((automation) => automation.enabled).length)
  return (
    <RailRow
      data-rail-top-row="automations"
      icon={<WorkflowIcon />}
      label="Automations"
      onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "automations" }))}
      end={on ? <span data-automations-on={on} className="tabular shrink-0 pr-1 text-label text-faint">{on} on</span> : null}
    />
  )
}

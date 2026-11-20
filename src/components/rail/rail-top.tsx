import { memo, useEffect, type ReactNode } from "react"
import { GitPullRequestIcon, InboxIcon, PackageIcon, SearchIcon, SquarePenIcon, WorkflowIcon } from "lucide-react"
import { formatChord, keysFor, runCommand, useCommands } from "@/extend/commands"
import { openInbox } from "@/components/inbox/open-inbox"
import { RailRow } from "@/components/rail/rail-row"
import { Keys } from "@/components/ui/kit"
import { automations, automationsOn, failedAutomationRuns, pendingProposals, useAutomations } from "@/state/automations"
import { toggleAutomations } from "@/state/automations-view"
import { inboxView, useInboxCount, useInboxRosters, useInboxView } from "@/state/inbox"
import { OPEN_PULLS_LISTED, openPullRequests, refreshOpenPulls, useOpenPulls } from "@/state/open-pulls"
import { usePrefs } from "@/state/prefs"
import { openProjectSetup } from "@/state/project-setup"
import { useSession } from "@/state/session"
import { useWindowRoutes } from "@/state/window-routes"

/**
 * The rail's fixed top: New thread, Search, Inbox, Pull requests, Setup and
 * Automations, above Pinned and the projects, quiet: a faint icon and the
 * label, and one count, the Inbox's, in the attention hue. Pull requests and
 * Automations say theirs in their tips; an automation that failed counts in the
 * Inbox, as a proposal does through its agent's ask. Each reads its own narrow
 * slice, so a token in a Thread or a row changing below repaints none of them;
 * the Inbox's count is a number from the same facts the marks read
 * (`useInboxCount`).
 *
 * A window whose Threads live on another computer (the web desk) has no
 * project of its own to ask GitHub or run automations in, so it shows the
 * first three.
 */
export const RailTop = memo(function RailTop() {
  const routed = useWindowRoutes((state) => state.routes !== null)
  return (
    <nav aria-label="Go to" data-rail-top className="flex shrink-0 flex-col gap-px px-2 pt-1 pb-1">
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
  const asks = useInboxCount()
  const seenAt = usePrefs((prefs) => prefs.automationsSeenAt)
  const failedSince = useAutomations((state) => failedAutomationRuns(state, seenAt))
  useEffect(() => {
    void automations.load()
  }, [])
  const count = asks + failedSince
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
        <span data-inbox-count={count} className="tabular shrink-0 pr-1 text-label font-medium text-attention">
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
      data-pulls-count={count ?? undefined}
      icon={<GitPullRequestIcon />}
      label="Pull requests"
      spoken={shown && count ? `Pull requests, ${shown} open` : "Pull requests"}
      title={shown && count ? `${shown} open on GitHub` : "Open on GitHub"}
      onClick={() => void openPullRequests(root)}
    />
  )
}

/** Automations over the conversation; how many are on, or wait on a decision, is its tip (the decisions are in the Inbox). */
function AutomationsRow() {
  const on = useAutomations(automationsOn)
  const proposed = useAutomations(pendingProposals)
  const open = useInboxView((state) => state.automations)
  return (
    <RailRow
      data-rail-top-row="automations"
      data-automations-on={on || undefined}
      data-automations-proposed={proposed || undefined}
      icon={<WorkflowIcon />}
      label="Automations"
      spoken={proposed ? `Automations, ${proposed} to decide` : "Automations"}
      title={[proposed ? `${proposed} to decide, in your Inbox` : undefined, on ? `${on} on` : undefined].filter(Boolean).join(" · ") || undefined}
      open={open}
      onClick={toggleAutomations}
    />
  )
}

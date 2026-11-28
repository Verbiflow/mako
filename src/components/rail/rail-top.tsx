import { memo, useEffect, type ReactNode } from "react"
import { CheckIcon, GitPullRequestIcon, InboxIcon, PackageIcon, SearchIcon, SquarePenIcon, WorkflowIcon } from "lucide-react"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, MenuItem, MenuLabel } from "@/components/ui/menu"
import { formatChord, keysFor, runCommand, useCommands } from "@/extend/commands"
import { openInbox } from "@/components/inbox/open-inbox"
import { RailRow } from "@/components/rail/rail-row"
import { ApexMark } from "@/components/ui/apex-mark"
import { Keys } from "@/components/ui/kit"
import { automations, automationsOn, failedAutomationRuns, pendingProposals, useAutomations } from "@/state/automations"
import { toggleAutomations } from "@/state/automations-view"
import { inboxView, useInboxCount, useInboxRosters, useInboxView } from "@/state/inbox"
import { boardReading } from "@mako/host/contracts/project-pulls"
import { usePanelFolders } from "@/components/pulls/pulls-offered"
import { openPullsPage } from "@/components/pulls/open-pulls-page"
import { useBoardWatch, usePullBoard } from "@/state/project-board"
import { pullsPane } from "@/state/inbox-view"
import { activeDocument, useViewer } from "@/state/viewer"
import { RAIL_NAV, setRailNav, usePrefs, type RailNavId } from "@/state/prefs"
import { openProjectSetup } from "@/state/project-setup"
import { useWindowRoutes } from "@/state/window-routes"

/**
 * The rail's fixed top: New thread, then Search, Inbox, Pull requests,
 * Automations and Setup as the person keeps them (Customize sidebar; Setup is
 * hidden at first), above Pinned and the projects, quiet: a faint icon and the
 * label, and one count, the Inbox's, in the attention hue. Pull requests and
 * Automations say theirs in their tips; an automation that failed counts in the
 * Inbox, as a proposal does through its agent's ask. Each reads its own narrow
 * slice, so a token in a Thread or a row changing below repaints none of them;
 * the Inbox's count is the page's "N need you" (`useInboxCount`): the same
 * facts the marks read and the Apex plan lines waiting on the person.
 *
 * A window whose Threads live on another computer (the web desk) has no
 * project of its own to run automations in, so it shows the first three and
 * Pull requests, which it asks of the computers that run its projects.
 */
export const RailTop = memo(function RailTop() {
  const routed = useWindowRoutes((state) => state.routes !== null)
  const nav = usePrefs((prefs) => prefs.railNav)
  // A window whose Threads live on another computer shows only what it can reach: Search, the Inbox and Pull requests,
  // which it asks of the computers that run its projects.
  const shows = (id: RailNavId) => nav[id] && (!routed || id === "search" || id === "inbox" || id === "pulls")
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <nav aria-label="Go to" data-rail-top className="flex shrink-0 flex-col gap-px px-2 pt-1 pb-1">
          <CommandRow command="session.new" icon={<SquarePenIcon />} label="New thread" />
          {routed ? null : <CommandRow command="apex.new" icon={<ApexMark />} label="New Apex" />}
          {shows("search") ? <CommandRow command="view.command-palette" icon={<SearchIcon />} label="Search" /> : null}
          {shows("inbox") ? <InboxRow /> : null}
          {shows("pulls") ? <PullsRow /> : null}
          {shows("automations") ? <AutomationsRow /> : null}
          {shows("setup") ? (
            <RailRow
              data-rail-top-row="setup"
              icon={<PackageIcon />}
              label="Setup"
              title="Files, accounts, tools and environments"
              onClick={openProjectSetup}
            />
          ) : null}
        </nav>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-56">
        <CustomizeItems />
      </ContextMenuContent>
    </ContextMenu>
  )
})

/**
 * Customize sidebar: each of the top rows is always shown or not shown, by the person, from a right-click on them or
 * the Projects header's `⋯`. New thread always shows. What's not shown is still a key and a palette entry away.
 */
export function CustomizeItems() {
  const nav = usePrefs((prefs) => prefs.railNav)
  return (
    <>
      <MenuLabel>Show in the sidebar</MenuLabel>
      {RAIL_NAV.map((id) => (
        <MenuItem
          key={id}
          role="menuitemcheckbox"
          aria-checked={nav[id]}
          data-customize={id}
          data-shown={nav[id] || undefined}
          title={nav[id] ? "Always shown; choose to stop showing it" : "Not shown; choose to always show it"}
          onSelect={(event) => {
            // The menu stays open for the next choice.
            event.preventDefault()
            setRailNav(id, !nav[id])
          }}
        >
          <span className="flex size-3.5 items-center justify-center">{nav[id] ? <CheckIcon className="size-3.5" /> : null}</span>
          {RAIL_NAV_WORDS[id]}
        </MenuItem>
      ))}
    </>
  )
}

const RAIL_NAV_WORDS = { search: "Search", inbox: "Inbox", pulls: "Pull requests", automations: "Automations", setup: "Setup" } satisfies Record<RailNavId, string>

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

/** The Pull requests page over the conversation; the project's reading is its tip, the count in the panel's tab. */
function PullsRow() {
  const folders = usePanelFolders()
  useBoardWatch(folders, "pulls", "glance")
  const { rows } = usePullBoard(folders)
  const reading = boardReading(rows)
  const open = useInboxView((state) => state.pulls)
  // Under a document's tab the page is still open but out of sight: the row brings it back rather than closing it.
  const covered = useViewer((state) => Boolean(activeDocument(state.documents, state.panes, state.focusedPaneId)))
  return (
    <RailRow
      data-rail-top-row="pulls"
      icon={<GitPullRequestIcon />}
      label="Pull requests"
      spoken={reading ? `Pull requests, ${reading.text}` : "Pull requests"}
      title={reading ? `${reading.text} in this project` : undefined}
      open={open}
      onClick={() => (open && !covered ? pullsPane.close() : openPullsPage())}
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

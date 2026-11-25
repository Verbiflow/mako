import { useEffect, useLayoutEffect, useState, type ReactNode } from "react"
import { ArchiveIcon, CheckIcon, ChevronDownIcon, ListChecksIcon, MailOpenIcon, XIcon } from "lucide-react"
import { mcpServerUnreachable } from "@mako/host/contracts/mcp-sign-ins"
import { AgentThreads } from "@/components/rail/agent-threads"
import { StoreFormatLine } from "@/components/shell/store-format-line"
import { TurnOnRailLine } from "@/components/settings/cloud-turn-on"
import { SyncRailLine } from "@/components/settings/sync-section"
import { McpSignInRailLine } from "@/components/settings/mcp-sign-ins"
import { UnopenedRailLine } from "@/components/settings/unopened-conversations"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slot } from "@/extend/slot"
import { cn } from "@/lib/utils"
import { useCloudAccount, watchAccountDetail } from "@/state/cloud-account"
import { useMcpSignIns } from "@/state/mcp-sign-ins"
import { usePrefs } from "@/state/prefs"
import { archivePicked, clearPicked, markPickedRead, useRailSelection } from "@/state/rail-selection"
import { putSetupChecklistAway, toggleSetupChecklist, useChecklistShown, useSetupSteps } from "@/state/setup-checklist"
import { useStoreFormats } from "@/state/store-formats"

/**
 * The session rail is the conversations, then one footer: whose desk this is and, only while something wants a look,
 * a quiet "N to resolve" that opens each problem with the one action that fixes it. Finish setting up sits above the
 * footer until it's done or put away; Threads picked together swap the footer for what a selection can do.
 */
export function SessionRail() {
  const picked = useRailSelection((state) => state.picked.length)
  return (
    <aside className="flex h-full min-h-0 flex-col">
      <AgentThreads />
      <SetupChecklist />
      {picked ? (
        <SelectionBar count={picked} />
      ) : (
        <div data-rail-footer className="flex shrink-0 items-start">
          <div className="min-w-0 flex-1">
            <Slot name="rail.footer" />
          </div>
          <RailIssues />
        </div>
      )}
    </aside>
  )
}

/** While a newer Mako's Thread store is only read here: the rail still lists every Thread. */
function ThreadStoreLine() {
  const row = useStoreFormats((state) => state.stores.find((store) => store.store === "threads" && store.access !== "write"))
  return row ? <StoreFormatLine row={row} className="border-t border-hairline px-3 py-2" /> : null
}

/** The lines that once stacked over the footer, each with its own fix: the popover's content, and what's counted. */
function IssueLines() {
  return (
    <>
      <McpSignInRailLine />
      <SyncRailLine />
      <UnopenedRailLine />
      <TurnOnRailLine />
      <ThreadStoreLine />
    </>
  )
}

/** How many children a box draws: each problem line is one, and draws nothing once it's resolved. */
function useLineCount(): [(node: HTMLDivElement | null) => void, number] {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [count, setCount] = useState(0)
  useLayoutEffect(() => {
    if (!node) return
    const read = () => setCount(node.childElementCount)
    read()
    const observer = new MutationObserver(read)
    observer.observe(node, { childList: true })
    return () => observer.disconnect()
  }, [node])
  return [setNode, count]
}

/**
 * "N to resolve": the problems once stacked over the footer, counted, each opening with the one action that fixes it.
 * Its dot is the attention violet only when the person must act (a server waits on their sign-in); otherwise grey.
 * Closed, the lines are drawn out of sight so the count is theirs; open, they're the popover's: never both.
 */
function RailIssues() {
  const [open, setOpen] = useState(false)
  const [measureHidden, hiddenLines] = useLineCount()
  const [measureShown, shownLines] = useLineCount()
  const servers = useMcpSignIns((state) => state.servers.filter((server) => server.way !== "settings" || !mcpServerUnreachable(server)).length)
  const signIns = useMcpSignIns((state) => state.servers.filter((server) => server.way !== "settings").length)
  const lines = open ? shownLines : hiddenLines
  // The MCP line names its first server and counts the rest: each is a problem of its own.
  const count = lines ? lines + Math.max(0, servers - 1) : 0
  const needsYou = signIns > 0
  return (
    <>
      {/* Closed, the lines are drawn out of sight, so the count is theirs; open, they're the popover's, drawn once. */}
      {open ? null : (
        <div ref={measureHidden} hidden aria-hidden>
          <IssueLines />
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-rail-issues={count || undefined}
            data-needs-you={needsYou || undefined}
            aria-label={`${count} to resolve`}
            hidden={!count && !open}
            className="pressable mt-2.5 mr-2 flex h-7 shrink-0 items-center gap-2 px-2 text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground aria-expanded:bg-fill-selected aria-expanded:text-foreground"
          >
            <span aria-hidden className={cn("size-1.5 rounded-full", needsYou ? "bg-attention" : "bg-foreground/35")} />
            <span className="tabular">{count} to resolve</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" sideOffset={6} className="w-72 p-0">
          <div ref={measureShown} data-rail-issue-lines className="[&>*:first-child]:border-t-0">
            <IssueLines />
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}

/** While Threads are picked, the footer is what a selection can do: Mark read (U), Archive (E), and Esc to let go. */
function SelectionBar({ count }: { count: number }) {
  return (
    <div data-selection-bar={count} role="toolbar" aria-label={`${count} selected`} className="flex h-11 shrink-0 items-center gap-0.5 px-2">
      <span className="tabular min-w-0 flex-1 truncate pl-2 text-ui whitespace-nowrap text-foreground">{count} selected</span>
      <button type="button" data-selection-action="read" onClick={() => void markPickedRead()} title="Mark read  U" aria-label="Mark read" className="pressable flex size-7 shrink-0 items-center justify-center text-faint hover:bg-fill-hover hover:text-foreground">
        <MailOpenIcon className="size-3.5" />
      </button>
      <button type="button" data-selection-action="archive" onClick={() => void archivePicked()} title="Archive  E" className="pressable flex h-7 shrink-0 items-center gap-1.5 px-1.5 text-ui text-foreground/80 hover:bg-fill-hover hover:text-foreground">
        <ArchiveIcon className="size-3.5 text-faint" />Archive
      </button>
      <button type="button" data-selection-action="clear" aria-label="Clear selection" title="Clear  Esc" onClick={clearPicked} className="pressable flex size-7 shrink-0 items-center justify-center text-faint hover:bg-fill-hover hover:text-foreground">
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}

/**
 * Finish setting up: what's left of a new desk, a step a row, each opening the place that does it. Folded, it's one
 * line with how far along; put away, it's in the palette and the account menu; done, it leaves for good.
 */
function SetupChecklist() {
  return useChecklistShown() ? <Checklist /> : null
}

function Checklist() {
  const steps = useSetupSteps()
  const open = usePrefs((prefs) => prefs.setupChecklist.open)
  const account = useCloudAccount((state) => (state.account?.state.status === "signed-in" ? state.account.state.account.id : undefined))
  // Whether a phone joined is read while the checklist shows.
  useEffect(() => (account ? watchAccountDetail("browsers", account) : undefined), [account])
  const done = steps.filter((step) => step.done).length
  return (
    <section data-setup-checklist={open ? "open" : "folded"} aria-label="Finish setting up" className="mx-2 mb-2 shrink-0 bg-surface">
      <div className="group/check flex h-8 items-center">
        <button type="button" onClick={toggleSetupChecklist} aria-expanded={open} className="pressable flex h-full min-w-0 flex-1 items-center gap-2 pr-1 pl-2 text-left">
          <ListChecksIcon className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
          <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">Finish setting up</span>
          <span data-setup-done={done} className="tabular text-label text-faint">
            {done} of {steps.length}
          </span>
          <ChevronDownIcon className={cn("size-3.5 text-faint transition-transform duration-200", open && "rotate-180")} />
        </button>
        <button
          type="button"
          aria-label="Put the checklist away"
          data-setup-put-away
          title="Put away. It stays in the palette and your account menu."
          onClick={putSetupChecklistAway}
          className="pressable mr-1 flex size-6 items-center justify-center text-faint opacity-0 transition-opacity group-hover/check:opacity-100 hover:bg-fill-hover hover:text-foreground focus-visible:opacity-100"
        >
          <XIcon className="size-3" />
        </button>
      </div>
      {open ? (
        <ol className="pb-1">
          {steps.map((step) => (
            <li key={step.id}>
              <StepRow id={step.id} done={step.done} onRun={step.run}>
                {step.label}
              </StepRow>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}

function StepRow({ id, done, onRun, children }: { id: string; done: boolean; onRun: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-setup-step={id}
      data-done={done || undefined}
      disabled={done}
      onClick={onRun}
      className="pressable group/step flex h-7 w-full items-center gap-2 px-2 text-left hover:bg-fill-hover disabled:hover:bg-transparent"
    >
      <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full", done ? "bg-foreground/70" : "border border-foreground/25")}>
        {done ? <CheckIcon className="size-2.5 text-shell" strokeWidth={3} /> : null}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-ui", done ? "text-faint line-through decoration-foreground/20" : "text-foreground/80 group-hover/step:text-foreground")}>{children}</span>
    </button>
  )
}

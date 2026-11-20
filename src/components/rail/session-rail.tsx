import { ArchiveIcon, MailOpenIcon, XIcon } from "lucide-react"
import { AgentThreads } from "@/components/rail/agent-threads"
import { StoreFormatLine } from "@/components/shell/store-format-line"
import { TurnOnRailLine } from "@/components/settings/cloud-turn-on"
import { SyncRailLine } from "@/components/settings/sync-section"
import { McpSignInRailLine } from "@/components/settings/mcp-sign-ins"
import { UnopenedRailLine } from "@/components/settings/unopened-conversations"
import { Slot } from "@/extend/slot"
import { archivePicked, clearPicked, markPickedRead, useRailSelection } from "@/state/rail-selection"
import { useStoreFormats } from "@/state/store-formats"

/**
 * The session rail is the conversations — one list for every harness,
 * folder-arranged — then its footer; Threads picked together swap the
 * footer for what a selection can do.
 */
export function SessionRail() {
  const picked = useRailSelection((state) => state.picked.length)
  return (
    <aside className="flex h-full min-h-0 flex-col">
      <AgentThreads />
      {picked ? (
        <SelectionBar count={picked} />
      ) : (
        <>
          <ThreadStoreLine />
          <McpSignInRailLine />
          <UnopenedRailLine />
          <TurnOnRailLine />
          <SyncRailLine />
          <Slot name="rail.footer" />
        </>
      )}
    </aside>
  )
}

/** Above the footer while a newer Mako's Thread store is only read here: the rail still lists every Thread. */
function ThreadStoreLine() {
  const row = useStoreFormats((state) => state.stores.find((store) => store.store === "threads" && store.access !== "write"))
  return row ? <StoreFormatLine row={row} className="border-t border-hairline px-3 py-2" /> : null
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

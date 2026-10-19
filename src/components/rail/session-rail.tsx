import { AgentThreads } from "@/components/rail/agent-threads"
import { StoreFormatLine } from "@/components/shell/store-format-line"
import { Slot } from "@/extend/slot"
import { useStoreFormats } from "@/state/store-formats"

/**
 * The session rail is the conversations — one list for every harness,
 * folder-arranged. The project's files moved to the inspector, beside
 * Changes and History, where the focused project's tree belongs; a rail
 * that answers two different questions needs a mode switch, and a mode
 * switch is a question of its own.
 */
export function SessionRail() {
  return (
    <aside className="flex h-full min-h-0 flex-col">
      <AgentThreads />
      <ThreadStoreLine />
      <Slot name="rail.footer" />
    </aside>
  )
}

/** Above the footer while a newer Mako's Thread store is only read here: the rail still lists every Thread. */
function ThreadStoreLine() {
  const row = useStoreFormats((state) => state.stores.find((store) => store.store === "threads" && store.access !== "write"))
  return row ? <StoreFormatLine row={row} className="border-t border-hairline px-3 py-2" /> : null
}

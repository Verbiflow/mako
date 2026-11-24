import type { NativeAgent } from "@mako/host/contracts/native-agents"

/**
 * A Fin's row: the file it changed that another open Thread of its Shiver changed too, in the same folder ("Also editing
 * agents.ts with tests"). Words alone, in the row's own muted line: its Apex was told, and the person may open either.
 */
export function FinSharingLine({ agent }: { agent: NativeAgent }) {
  const sharing = agent.child?.sharing
  if (!sharing) return null
  return (
    <span data-fin-sharing className="truncate text-label text-muted-foreground" title={sharing}>
      {sharing}
    </span>
  )
}

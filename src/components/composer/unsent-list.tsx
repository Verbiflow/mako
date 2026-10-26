import { XIcon } from "lucide-react"
import type { RejectedDraft } from "@/state/drafts"
import { restoreUnsent } from "@/lib/saved-message-draft"

/** Each kept copy, newest first, with its own Restore and Dismiss. */
export function UnsentList({ drafts, take, dismissLabel }: { drafts: readonly RejectedDraft[]; take(id: string): RejectedDraft | undefined; dismissLabel: string }) {
  return (
    <ul className="-mx-1 flex flex-col">
      {[...drafts].reverse().slice(0, 20).map((draft) => (
        <li key={draft.id} className="flex items-center gap-1">
          <button
            type="button"
            className="pressable flex min-w-0 flex-1 items-baseline gap-2 rounded-md px-1 py-1 text-left hover:bg-fill-hover"
            onClick={() => {
              const taken = take(draft.id)
              if (taken) restoreUnsent(taken)
            }}
          >
            <span className="min-w-0 flex-1 truncate text-ui text-foreground/90">{draft.text || "Attachments"}</span>
            <span className="shrink-0 text-label text-faint">Restore</span>
          </button>
          <button
            type="button"
            aria-label={dismissLabel}
            title={dismissLabel}
            className="pressable grid size-6 shrink-0 place-items-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground"
            onClick={() => take(draft.id)}
          >
            <XIcon className="size-3.5" />
          </button>
        </li>
      ))}
      {drafts.length > 20 ? <li className="px-1 pt-1 text-label text-faint">Restore or dismiss a copy to see the next one.</li> : null}
    </ul>
  )
}

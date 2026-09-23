import { useState } from "react"
import { XIcon } from "lucide-react"
import { Notice, NoticeAction } from "@/components/ui/notice"
import type { RejectedDraft } from "@/state/drafts"
import { takeInterruptedSend, useSendRecovery } from "@/state/send-recovery"

export function InterruptedSends({
  onRestore,
}: {
  onRestore: (draft: RejectedDraft) => void
}) {
  const drafts = useSendRecovery((state) => state.interrupted)
  const [expanded, setExpanded] = useState(false)
  if (!drafts.length) return null
  return (
    <Notice
      tone="caution"
      label="Interrupted sends"
      title="Send interrupted"
      description="Delivery could not be confirmed. Check the conversation before sending again."
      className="mx-2 mt-2"
    >
      <div className="-mx-1 max-h-40 overflow-auto">
        {drafts.slice(0, expanded ? 20 : 2).map((draft) => (
          <div key={draft.id} className="group/draft flex items-center gap-1">
            <button
              type="button"
              className="pressable flex min-w-0 flex-1 items-baseline gap-2 rounded-md px-1 py-1 text-left hover:bg-fill-hover"
              onClick={() => {
                onRestore(draft)
                takeInterruptedSend(draft.id)
              }}
            >
              <span className="min-w-0 flex-1 truncate text-ui text-foreground/90">
                {draft.text || "Attachments"}
              </span>
              <span className="shrink-0 text-label text-faint">Restore</span>
            </button>
            <button
              type="button"
              aria-label="Dismiss recovery copy"
              title="Dismiss recovery copy"
              className="pressable grid size-6 shrink-0 place-items-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground"
              onClick={() => takeInterruptedSend(draft.id)}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      {drafts.length > 2 && !expanded ? (
        <div className="-ml-2 mt-1">
          <NoticeAction quiet onClick={() => setExpanded(true)}>
            Show {drafts.length - 2} more
          </NoticeAction>
        </div>
      ) : null}
      {expanded && drafts.length > 20 ? (
        <p className="mt-1 text-label text-faint">
          Restore or dismiss a copy to see the next one.
        </p>
      ) : null}
    </Notice>
  )
}

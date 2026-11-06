import { use, useState } from "react"
import { APEX_WORD, finsWord } from "@mako/host/contracts/agents"
import { XIcon } from "lucide-react"
import { LiveMark } from "@/components/ui/live-mark"
import { ApexMark } from "@/components/ui/apex-mark"
import { useAcp } from "@/state/acp"
import { unaddress, useAddressee, useThreadChildren, useThreadRollup } from "@/state/apex-fins"
import { AgentsSheet } from "./agents"
import { FinOfApexContext } from "./fin-of-apex"
import { WebHarnessIcon } from "./harness-icon"

/**
 * Over the phone's composer in an Apex's Thread: who a message goes to. In the Apex's own view, the Apex, which passes
 * it on, or the Fin a routing line's Reply chose, straight; in one of its Fins, that Fin directly, its Apex told of it.
 */
export function FinOfApexNote({ conversation }: { conversation: string }) {
  const apex = use(FinOfApexContext)
  const thread = useAcp((state) => state.conversations[conversation]?.threadId)
  const title = useAcp((state) => state.conversations[conversation]?.title)
  const isApex = useThreadRollup(apex ? undefined : thread).total > 0
  const addressee = useAddressee((state) => (apex ? undefined : state.to[conversation]))
  if (!apex && !isApex) return null
  if (addressee)
    return (
      <div data-child-note="direct" data-addressee={addressee.name} className="mx-auto flex w-full max-w-content min-w-0 items-center gap-1.5 px-4 pt-2 text-label text-faint">
        <span title={`Straight to ${addressee.title}; ${title ?? `its ${APEX_WORD}`} sees what you said`} className="flex h-7 min-w-0 shrink items-center gap-1.5 bg-raised pr-0.5 pl-2.5 text-label text-foreground">
          <LiveMark kind="fin" state="idle" size={16} cut="var(--raised)" className="live-mark-still">
            <WebHarnessIcon harness={addressee.provider} />
          </LiveMark>
          <span className="min-w-0 truncate">To {addressee.title}</span>
          <button type="button" aria-label={`Write to ${title ?? `the ${APEX_WORD}`} instead`} onClick={() => unaddress(conversation)} className="pressable flex size-6 shrink-0 items-center justify-center text-faint">
            <XIcon className="size-3" />
          </button>
        </span>
      </div>
    )
  return null
}

/**
 * In an Apex's bar on the phone: how many Fins it has, which opens them in Agents. The Fins themselves stand in the
 * crew card and the list; a chip each repeated them over the card as they spawned. It counts the roster this window
 * holds rather than the host's listed count, so it stands once the Agents it opens and the crew card can be drawn.
 */
export function PhoneFinCount({ thread, conversation }: { thread: string; conversation: string }) {
  const total = useThreadChildren(thread).length
  const [roster, setRoster] = useState(false)
  if (!total) return null
  return (
    <>
      <button type="button" data-apex-count={total} aria-label={`${finsWord(total)}, in Agents`} onClick={() => setRoster(true)} className="pressable flex h-11 shrink-0 items-center gap-1 px-2 text-label text-muted-foreground">
        <ApexMark className="size-3.5" />
        <span className="tabular">{total}</span>
      </button>
      <AgentsSheet conversation={conversation} open={roster} onDismiss={() => setRoster(false)} />
    </>
  )
}

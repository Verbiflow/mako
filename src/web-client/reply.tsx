import { useEffect, useState } from "react"
import { CheckIcon, CopyIcon, GitBranchIcon } from "lucide-react"
import { toast } from "sonner"
import type { CompactReply } from "@/components/transcript/compact-presentation"
import { Spinner } from "@/components/ui/spinner"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { branchReply, copyReply, offerReply } from "./replies"
import { Sheet } from "./sheet"

/**
 * Under the newest reply on a phone: Copy and Branch, a thumb's size, so the two things done most with an answer are
 * one tap. Every other reply keeps them under a long press (`useReplyHold`). Branch is offered only where the host can
 * fork after this answer; Copy whenever there are words to copy.
 */
export function PhoneReply({ reply }: { reply: CompactReply }) {
  useEffect(() => offerReply(reply), [reply])
  const newest = useAcp((state) => activeLiveAcp(state)?.projection?.exchanges.at(-1)?.id === reply.exchange)
  if (!newest) return null
  return (
    <span className="web-reply-actions" data-reply-actions={reply.exchange}>
      {reply.text ? <CopyReply text={reply.text} /> : null}
      {reply.branch ? <BranchReply branch={reply.branch} /> : null}
    </span>
  )
}

function CopyReply({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button type="button" data-reply-action="copy" className="web-reply-action pressable" onClick={() => void copyReply(text).then(() => setCopied(true))}>
      {copied ? <CheckIcon aria-hidden className="size-4 text-positive" /> : <CopyIcon aria-hidden className="size-4" />}
      <span role="status">{copied ? "Copied" : "Copy"}</span>
    </button>
  )
}

function BranchReply({ branch }: { branch: NonNullable<CompactReply["branch"]> }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      data-reply-action="branch"
      disabled={busy}
      className="web-reply-action pressable"
      onClick={() => {
        setBusy(true)
        void branchReply(branch).finally(() => setBusy(false))
      }}
    >
      {busy ? <Spinner aria-hidden className="size-4" /> : <GitBranchIcon aria-hidden className="size-4" />}
      <span>{busy ? "Branching…" : "Branch"}</span>
    </button>
  )
}

/** The long press's choices for one reply. */
export function ReplySheet({ reply, onDismiss }: { reply: CompactReply | undefined; onDismiss: () => void }) {
  return (
    <Sheet open={reply !== undefined} onDismiss={onDismiss} label="This reply">
      <div className="flex flex-col px-2 pt-1 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        {reply?.text ? (
          <button
            type="button"
            data-reply-menu="copy"
            className="web-choice"
            onClick={() => {
              onDismiss()
              void copyReply(reply.text).then(() => toast.success("Copied the reply"), () => undefined)
            }}
          >
            <CopyIcon aria-hidden className="size-[18px] text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span>Copy</span>
              <span className="text-label text-faint">The whole reply, as it was written</span>
            </span>
          </button>
        ) : null}
        {reply?.branch ? (
          <button
            type="button"
            data-reply-menu="branch"
            className="web-choice"
            onClick={() => {
              const branch = reply.branch!
              onDismiss()
              void branchReply(branch)
            }}
          >
            <GitBranchIcon aria-hidden className="size-[18px] text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span>Branch from here</span>
              <span className="text-label text-faint">A new Session in this Thread, from after this reply</span>
            </span>
          </button>
        ) : null}
      </div>
    </Sheet>
  )
}

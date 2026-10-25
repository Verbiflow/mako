import type { ComposerNotice, ComposerNoticeProps } from "@/extend/notices"
import { takeRejectedDraft, useDrafts } from "@/state/drafts"
import { takeInterruptedSend, useSendRecovery } from "@/state/send-recovery"
import { restoreUnsent } from "@/lib/saved-message-draft"
import { UnsentList } from "./unsent-list"

const plural = (count: number) => (count === 1 ? "1 message" : `${count} messages`)

/**
 * One line while a send this window began was cut off before the host
 * confirmed it (the window closed or reloaded mid-send): the copy kept here
 * may or may not have reached the agent. Restore puts the newest back in the
 * draft; the rest, each with its own Restore and Dismiss, are in its detail.
 * They are recovery copies, never an outbox: nothing here sends.
 */
export function useInterruptedSendsNotice(): ComposerNotice | null {
  const drafts = useSendRecovery((state) => state.interrupted)
  if (!drafts.length) return null
  const newest = drafts.at(-1)!
  return {
    id: "interrupted-sends",
    tone: "caution",
    title: `${plural(drafts.length)} may not have been delivered`,
    description: "check the conversation before sending again",
    detail: <UnsentList drafts={drafts} take={takeInterruptedSend} dismissLabel="Dismiss recovery copy" />,
    actions: [{
      label: "Restore",
      primary: true,
      title: newest.text.slice(0, 200) || "Attachments",
      onClick: () => {
        const taken = takeInterruptedSend(newest.id)
        if (taken) restoreUnsent(taken)
      },
    }],
    data: { "data-interrupted-sends": String(drafts.length) },
  }
}

/**
 * One line while a send to this draft's conversation was refused before it
 * started (no model, no key): its words are kept, and Restore puts them back
 * once the draft has room for them.
 */
export function useRejectedDraftsNotice({ draftKey }: ComposerNoticeProps): ComposerNotice | null {
  const all = useDrafts((state) => state.rejected)
  const drafts = all.filter((item) => item.key === draftKey)
  if (!drafts.length) return null
  const newest = drafts.at(-1)!
  return {
    id: `rejected-drafts:${draftKey}`,
    tone: "caution",
    title: drafts.length === 1 ? "Message not sent" : `${plural(drafts.length)} not sent`,
    description: newest.text.slice(0, 120) || "Attachments",
    detail: drafts.length > 1 ? <UnsentList drafts={drafts} take={takeRejectedDraft} dismissLabel="Dismiss unsent message" /> : undefined,
    actions: [{
      label: "Restore",
      primary: true,
      onClick: () => {
        const taken = takeRejectedDraft(newest.id)
        if (taken) restoreUnsent(taken)
      },
    }],
    data: { "data-rejected-drafts": String(drafts.length) },
  }
}

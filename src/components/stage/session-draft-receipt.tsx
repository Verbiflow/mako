import { HarnessIcon } from "@/components/ui/provider-icon"
import { hasThreadToken, threadReferenceId, threadToken, toggleThreadToken } from "@/lib/mentions"
import { prefetchThreadReferences } from "@/lib/thread-references"
import type { ThreadRef } from "@/lib/types"
import { cn } from "@/lib/utils"
import { draftText, rememberDraft, useDrafts } from "@/state/drafts"
import { sessionDraftKey, type SessionDraft } from "@/state/thread-groups"
import { sessionTabTitle, useThreadTabs } from "@/state/thread-sessions"
import { threadsStore, useThreads } from "@/state/threads"

/** The new tab before its first message: which Thread it joins, and that nothing runs yet. */
export function SessionDraftReceipt({ draft }: { draft: SessionDraft }) {
  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="max-w-md truncate text-title font-medium text-foreground">New session in {draft.title}</p>
      <p className="text-ui text-muted-foreground">Pick an agent below. Nothing starts until you send.</p>
      <ThreadTranscripts draft={draft} />
    </div>
  )
}

/**
 * The Thread's other Sessions, each a reference the first message can carry.
 * A chip only adds or removes the `@thread` token in the draft, so the
 * composer's chip and this one always agree, and the send reads each
 * transcript as it is then.
 */
function ThreadTranscripts({ draft }: { draft: SessionDraft }) {
  const tabs = useThreadTabs({ thread: draft.thread, draft })
  const refs = useThreads((state) => state.threads)
  const key = sessionDraftKey(draft)
  const text = useDrafts((state) => state.drafts.find((entry) => entry.key === key)?.text ?? "")
  const sessions = tabs.flatMap((tab) => {
    if (tab.kind !== "session") return []
    const ref = tab.ref ?? refs.find((candidate) => candidate.path === tab.presence?.threadPath)
    return [{ tab, ref, harness: ref?.harness ?? tab.presence?.harness }]
  })
  if (!key || !sessions.length) return null
  const toggle = (ref: ThreadRef) => {
    const id = threadReferenceId(ref)
    const next = toggleThreadToken(draftText(key), ref.harness, id)
    rememberDraft(key, next)
    if (hasThreadToken(next, ref.harness, id)) prefetchThreadReferences(threadToken(ref.harness, id), threadsStore.get().threads)
  }
  return (
    <div className="mt-5 flex max-w-lg flex-col items-center gap-2">
      <p className="text-label text-faint">Include a transcript</p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {sessions.map(({ tab, ref, harness }) => {
          const on = ref ? hasThreadToken(text, ref.harness, threadReferenceId(ref)) : false
          return (
            <button
              key={tab.id}
              type="button"
              aria-pressed={on}
              disabled={!ref}
              title={ref ? undefined : "No transcript yet"}
              data-draft-transcript={tab.id}
              onClick={() => { if (ref) toggle(ref) }}
              className={cn(
                "pressable inline-flex h-7 max-w-60 items-center gap-1.5 rounded-md px-2 text-ui ring-1 ring-inset transition-colors disabled:opacity-40",
                on ? "bg-fill-selected text-foreground ring-border" : "text-muted-foreground ring-hairline hover:bg-fill-hover hover:text-foreground"
              )}
            >
              {harness ? <HarnessIcon harness={harness} className="size-3.5 shrink-0" /> : null}
              <span className="truncate">{sessionTabTitle(tab)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

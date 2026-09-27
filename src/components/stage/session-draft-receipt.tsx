import type { SessionDraft } from "@/state/thread-groups"

/** The new tab before its first message: which Thread it joins, and that nothing runs yet. */
export function SessionDraftReceipt({ draft }: { draft: SessionDraft }) {
  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="max-w-md truncate text-title font-medium text-foreground">New session in {draft.title}</p>
      <p className="text-ui text-muted-foreground">Pick an agent below. Nothing starts until you send.</p>
    </div>
  )
}

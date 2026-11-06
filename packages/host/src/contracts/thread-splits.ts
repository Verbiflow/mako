/**
 * A Thread a split made (`docs/one-conversation.md`): before a Thread was one conversation, `from` held `session` as
 * one of its tabs. The Session first in tab order kept `from` itself, so it has no entry.
 */
export interface ThreadSplit {
  thread: string
  from: string
  session: string
  /** `from`'s own name when it was split, for the crumb that says where the Thread came from. */
  fromTitle?: string
}

/** Where a Thread came from, as its crumb says it: the Thread it was forked from, or the one a split took it out of. */
export interface ThreadOrigin {
  kind: "fork" | "split"
  from: string
  /** `from`'s name when it was split: it may have none now. */
  title?: string
}

/** What a window keeps of a Thread's new tab (`SessionDraft` in `src/state/thread-groups.ts`), as far as a split reads it. */
export interface CarriedDraft {
  thread: string
  session?: string
  key?: string
}

/**
 * A window's new-tab drafts after a split. A draft whose send already named its Session goes with that Session to the
 * Thread the split made, keeping the key its text is kept under, so the text is found where it was. A draft that named
 * no Session stays with the Thread that kept its ID. Two drafts never land on one Thread: the one already there stays.
 */
export function carryDrafts<T extends CarriedDraft>(drafts: readonly T[], splits: readonly ThreadSplit[]): T[] {
  const bySession = new Map(splits.map((split) => [split.session, split]))
  const carried = new Map<string, T>()
  const moved: T[] = []
  for (const draft of drafts) {
    const split = draft.session === undefined ? undefined : bySession.get(draft.session)
    if (split && split.from === draft.thread) moved.push({ ...draft, thread: split.thread, key: draft.key ?? `thread-session:${draft.thread}` })
    else carried.set(draft.thread, draft)
  }
  for (const draft of moved) if (!carried.has(draft.thread)) carried.set(draft.thread, draft)
  return [...carried.values()]
}

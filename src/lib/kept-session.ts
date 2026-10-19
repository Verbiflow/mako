import { harnessLabel } from "@/lib/harness-label"
import type { ThreadRef } from "@/lib/types"

/** What the rail, the transcript and the composer say of a session its harness deleted. */
export interface KeptSessionText {
  /** One quiet line: who keeps it, and why it's not the harness's. */
  line: string
  /** What that means for reading and replying, for a tip. */
  detail: string
}

/**
 * The words for a session Mako serves because its harness deleted it
 * (`ThreadRef.archived`): from its records in Mako's record store, or, when
 * Mako never kept those, from Mako's own copy (`ThreadRef.copyOnly`). Null
 * for a session its harness still has.
 */
export function keptSessionText(ref: Pick<ThreadRef, "harness" | "archived" | "copyOnly">): KeptSessionText | null {
  if (!ref.archived) return null
  const harness = harnessLabel(ref.harness)
  return ref.copyOnly
    ? {
        line: `Mako's copy · ${harness} deleted this session`,
        detail: `Mako kept this conversation as it read it at the time. The original records are gone, so ${harness} can't resume it and newer versions of Mako can't read it again. A reply continues it in a new session, from this transcript.`,
      }
    : {
        line: `Kept by Mako · ${harness} deleted this session`,
        detail: `Mako kept the session's own records, so it reads as ${harness} wrote it. A reply puts it back in ${harness}, which resumes it as the same session.`,
      }
}

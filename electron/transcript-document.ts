import { formatTranscript, type Thread, type ThreadEntry, type TranscriptDepth } from "@mako/sessions"
import type { LiveSnapshot } from "./contracts/live-conversations.js"
import type { TranscriptDocument, TranscriptSource } from "./contracts/transcript-document.js"
import { liveEntries } from "./live-context.js"

/** What a transcript reads of a live conversation. */
export type LiveHistory = Pick<LiveSnapshot, "base" | "baseCoveredBlocks" | "blocks"> & { session: Pick<LiveSnapshot["session"], "title" | "harness"> }

export interface TranscriptDocumentDeps {
  snapshot(id: string): LiveHistory | null
  openThread(path: string): Promise<Thread | null>
}

/**
 * A Session's transcript. While it runs here, its captured live history
 * after the native record it resumed, because the native file can trail the
 * stream; otherwise its native record.
 */
export async function transcriptDocument(deps: TranscriptDocumentDeps, source: TranscriptSource, depth: TranscriptDepth): Promise<TranscriptDocument> {
  if (source.kind === "file") {
    const thread = await deps.openThread(source.path)
    if (!thread) throw new Error("This session's history could not be read")
    return render(thread.ref.title, thread.ref.harness, thread.entries, depth)
  }
  const snapshot = deps.snapshot(source.id)
  if (!snapshot) throw new Error("This session isn't open on this Mac any more")
  const entries = [...await resumed(deps, snapshot), ...liveEntries(snapshot.blocks.slice(snapshot.baseCoveredBlocks ?? 0))]
  return render(snapshot.session.title, snapshot.session.harness, entries, depth)
}

/** The native history a live conversation resumed, whole: its base page may hold only the latest turns. */
async function resumed(deps: TranscriptDocumentDeps, snapshot: LiveHistory): Promise<ThreadEntry[]> {
  const base = snapshot.base
  if (!base) return []
  if (base.start === 0 && !base.preview) return base.entries
  const whole = await deps.openThread(base.ref.path)
  if (!whole) return base.entries
  return base.preview ? whole.entries : whole.entries.slice(0, base.start + base.entries.length)
}

function render(title: string | undefined, harness: string, entries: readonly ThreadEntry[], depth: TranscriptDepth): TranscriptDocument {
  const body = formatTranscript(entries, depth)
  const document: TranscriptDocument = { harness, markdown: `# ${title ?? "Untitled session"}\n\n${body || "_Nothing said yet._"}\n` }
  if (title) document.title = title
  return document
}

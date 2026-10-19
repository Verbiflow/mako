import { buildTranscript, type Thread } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import type { LiveSnapshot } from "../contracts/live-conversations.js"
import type { TranscriptDepth, TranscriptDocument, TranscriptSource } from "../contracts/transcript-document.js"
import { resumed } from "./resumed-history.js"

/** What a transcript reads of a live conversation. */
export type LiveHistory = Pick<LiveSnapshot, "base" | "baseCoveredBlocks" | "blocks"> & { session: Pick<LiveSnapshot["session"], "title" | "harness"> }

export interface TranscriptDocumentDeps {
  snapshot(id: string): Promise<LiveHistory | null>
  openThread(path: string): Promise<Thread | null>
  /** A harness's id as people read it. */
  label(harness: string): string
}

/**
 * A Session's transcript, as the copy for a person reads
 * (`buildTranscript`, folded): oldest first, each call on one line, and at
 * `concise` only what the person and the agent said. While it runs here,
 * its captured live history after the native record it resumed, because
 * the native file can trail the stream; otherwise its native record.
 */
export async function transcriptDocument(deps: TranscriptDocumentDeps, source: TranscriptSource, depth: TranscriptDepth): Promise<TranscriptDocument> {
  if (source.kind === "file") {
    const thread = await deps.openThread(source.path)
    if (!thread) throw new Error("This session's history could not be read")
    return render(deps, thread.ref.title, thread.ref.harness, thread.entries, depth)
  }
  const snapshot = await deps.snapshot(source.id)
  if (!snapshot) throw new Error("This session isn't open on this Mac any more")
  const entries = [...await resumed(deps, snapshot), ...snapshot.blocks.slice(snapshot.baseCoveredBlocks ?? 0)]
  return render(deps, snapshot.session.title, snapshot.session.harness, entries, depth)
}

async function render(deps: TranscriptDocumentDeps, title: string | undefined, harness: string, entries: readonly Entry[], depth: TranscriptDepth): Promise<TranscriptDocument> {
  const built = await buildTranscript({ entries, harness: deps.label(harness), label: deps.label, ...title !== undefined && { title } }, { folded: true, concise: depth === "concise" })
  const document: TranscriptDocument = { harness, markdown: built.markdown }
  if (title) document.title = title
  return document
}

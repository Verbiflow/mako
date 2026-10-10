import type { MethodTable } from "@mako/host/base/methods"
import type { TranscriptDocument } from "@mako/host/contracts/transcript-document"
import { transcriptDocument, type TranscriptDocumentDeps } from "../transcript-document.js"

/** A Session's transcript for the transcript tab, read again whenever the tab asks. */
export function installTranscriptDocumentIpc(methods: MethodTable, deps: TranscriptDocumentDeps) {
  methods.handle("mako:transcript-document", (source, depth): Promise<TranscriptDocument> => transcriptDocument(deps, source, depth))
}

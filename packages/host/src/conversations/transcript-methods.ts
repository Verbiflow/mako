import type { MethodTable } from "../base/methods.js"
import type { TranscriptDocument } from "../contracts/transcript-document.js"
import { transcriptDocument, type TranscriptDocumentDeps } from "./transcript-document.js"

/** A Session's transcript for the transcript tab, read again whenever the tab asks. */
export function declareTranscriptMethods(methods: MethodTable, deps: TranscriptDocumentDeps) {
  methods.handle("mako:transcript-document", (source, depth): Promise<TranscriptDocument> => transcriptDocument(deps, source, depth))
}

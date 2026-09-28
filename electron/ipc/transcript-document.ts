import { registerIpc } from "./register.js"
import type { TranscriptDocument } from "../contracts/transcript-document.js"
import { transcriptDocument, type TranscriptDocumentDeps } from "../transcript-document.js"

/** A Session's transcript for the transcript tab, read again whenever the tab asks. */
export function installTranscriptDocumentIpc(deps: TranscriptDocumentDeps) {
  registerIpc("mako:transcript-document", (_event, source, depth): Promise<TranscriptDocument> => transcriptDocument(deps, source, depth))
}

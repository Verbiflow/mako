import { createContext, useContext, useMemo } from "react"
import type { FileReferenceSource } from "@mako/host/contracts/file-references"
export interface TranscriptSource {
  threadPath?: string
  liveId?: string
  historyFrom?: { blocks: number; base: number }
}
export const TranscriptSourceContext = createContext<TranscriptSource>({})
export const useTranscriptSource = () => useContext(TranscriptSourceContext)

/** When the answer around it was finished; undefined while it streams, or outside an answer. */
export const AnswerTimeContext = createContext<number | undefined>(undefined)

/** The request the answer around it answers: whose recorded changes its file links read. */
export const AnswerRequestContext = createContext<string | undefined>(undefined)

/** What a file spelling here is resolved against: the transcript, as of its answer's time. */
export function useReferenceSource(): FileReferenceSource {
  const { liveId, threadPath } = useTranscriptSource()
  const asOf = useContext(AnswerTimeContext)
  return useMemo(() => ({ liveId, threadPath, asOf }), [liveId, threadPath, asOf])
}

import { createContext, useContext, useMemo } from "react"
import type { FileReferenceSource } from "@mako/host/contracts/file-references"
export interface TranscriptSource {
  threadPath?: string
  liveId?: string
  historyFrom?: { blocks: number; base: number }
}
export const TranscriptSourceContext = createContext<TranscriptSource>({})
export const useTranscriptSource = () => useContext(TranscriptSourceContext)

/**
 * Whether the turn around it is running now. Only a running turn's calls
 * sweep: a call a finished record left without a result is not running,
 * however it reads.
 */
export const TurnRunningContext = createContext(false)

/**
 * The harness answering in the transcript around it: whose mark an agent it
 * started shows when the roster doesn't name another (`AgentMark`).
 */
export const HarnessContext = createContext<string | undefined>(undefined)

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

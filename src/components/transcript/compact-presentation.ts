import { createContext, type ReactNode } from "react"
import type { ToolCall } from "@/extend/slots"

/**
 * A transcript drawn under a finger on a phone's width: the same exchanges, their work and their answers, with the
 * pieces a phone draws its own way handed to whoever provides this (the web client). Absent, as on every desk, the
 * transcript draws its folds and footers as it always does.
 */
export interface CompactPresentation {
  /** A run of steps, drawn as one line that opens them; without it, the desk's folds. */
  steps?: (run: CompactSteps) => ReactNode
  /** What a finished reply offers under it, and under a long press: its words to copy, and a branch from it. */
  reply?: (reply: CompactReply) => ReactNode
  /** False on a phone's width: no rail of turns beside the transcript, and no gutter kept for one. */
  navigator?: false
}

export interface CompactSteps {
  /** Which run, for as long as the transcript keeps it: its exchange, and its place in it. */
  id: string
  /** Its calls, in the order they began. */
  calls: readonly ToolCall[]
  /** The harness that made them, for an agent group's mark. */
  provider?: string
  /** The running end of a turn. */
  live: boolean
  /** The turn stopped, or failed, on this run. */
  interrupted: boolean
  failed: boolean
  /** How long the run worked, when it's done: a settled turn's fold knows it. */
  worked?: number
  /** A settled turn's fold: everything it hides, drawn as the desk draws it, prose between steps included. */
  body?: ReactNode
}

export interface CompactReply {
  exchange: string
  /** The whole answer, as Copy takes it. */
  text: string
  /** Starts a new Session from after this answer, in this Thread: its conversation once made. Absent where its host can't. */
  branch?: () => Promise<string | undefined>
}

export const CompactPresentationContext = createContext<CompactPresentation | null>(null)

import { z } from "zod"

export const SIDE_QUESTION_LIMIT = 4_000

export const SideQuestionCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ask"), question: z.string().trim().min(1).max(SIDE_QUESTION_LIMIT) }),
  /** Stop the answer being written; the side conversation stays open. */
  z.object({ kind: z.literal("stop") }),
  /** Close the side conversation; a harness that copied the session for it discards the copy. */
  z.object({ kind: z.literal("close") }),
])
export type SideQuestionCommand = z.infer<typeof SideQuestionCommandSchema>

export type SideExchangeStatus = "answering" | "answered" | "stopped" | "failed"

/** One question in a side conversation and its answer so far. */
export interface SideExchange {
  id: string
  question: string
  answer: string
  status: SideExchangeStatus
  error?: string
  askedAt: number
  answeredAt?: number
}

/**
 * Questions asked beside a conversation, answered from its context without
 * interrupting its turn or joining it. Held by this host only: neither the
 * journal nor the transcript keeps it, and it closes with the conversation's
 * process.
 */
export interface SideConversation {
  id: string
  /** `harness`: the harness's own side question. `fork`: Mako asks a copy of the session it discards on close. */
  by: "harness" | "fork"
  exchanges: SideExchange[]
}

/** An answered exchange, as a harness that keeps no side conversation of its own is told it again. */
export interface EarlierExchange {
  question: string
  answer: string
}

/**
 * What a harness without a side question of its own is told before the
 * question, in a session that copies the conversation: the conversation is
 * reference, not the task, and nothing changes.
 */
export const SIDE_QUESTION_BOUNDARY = [
  "Side question boundary.",
  "",
  "Everything before this message is the conversation this side question was asked beside. It is reference only, not your task. Don't continue, execute or complete anything from it: no plans, tool calls, edits or requests made there.",
  "",
  "Answer the question below from that conversation's context. You may read and search files to answer it, but change nothing: no edits, no commands that write, no git operations, no subagents. If the conversation doesn't say, say so.",
].join("\n")

/** What a harness that generates from the conversation's context, with no side question of its own, is told ahead of the question. */
export const SIDE_QUESTION_ASIDE =
  "This is a side question, asked beside the conversation above and kept out of it. Answer it directly from that conversation's context, in plain text. Don't continue the conversation's task, and if the conversation doesn't say, say so."

/** The question with the side conversation's earlier exchanges ahead of it, for a harness that answers each question alone. */
export function withEarlierExchanges(question: string, earlier: readonly EarlierExchange[]): string {
  if (!earlier.length) return question
  const told = earlier.map((exchange, index) => `Side question ${index + 1}: ${exchange.question}\nYour answer: ${exchange.answer}`)
  return [
    "This side conversation so far, which the main conversation doesn't include:",
    "",
    ...told,
    "",
    `Side question ${earlier.length + 1}, which follows up on those; "I" and "you" mean the side conversation's asker and answerer, and "just asked" means its last side question:`,
    question,
  ].join("\n")
}

/** `answer`, or a rejection once the user stops it; a harness that can't take a stop finishes the answer unread. */
export function untilStopped<T>(answer: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Stopped"))
  return new Promise<T>((resolve, reject) => {
    const stopped = () => reject(new Error("Stopped"))
    signal.addEventListener("abort", stopped, { once: true })
    answer.then(resolve, reject).finally(() => signal.removeEventListener("abort", stopped))
  })
}

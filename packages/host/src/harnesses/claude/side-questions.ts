import { z } from "zod"
import type { Query } from "@anthropic-ai/claude-agent-sdk"
import type { DriverSideQuestion } from "../live-driver.js"

/**
 * `Query.askSideQuestion`, which SDK 0.3.283 has and its typings leave out:
 * Claude Code's `/btw`, answered from the session's context while a turn runs
 * and kept out of its transcript. `history` is the side conversation so far,
 * as the CLI's `side_question` control request reads it.
 */
interface SideQuestionQuery {
  askSideQuestion(question: string, options: SideQuestionOptions): Promise<z.input<typeof SideAnswerSchema>>
}

interface SideQuestionOptions {
  history?: { question: string; response: string }[]
  signal?: AbortSignal
}

const SideAnswerSchema = z.object({ response: z.string().nullable() }).nullable()

/** The answer, whole; Claude's side question doesn't stream. */
export async function askClaudeSideQuestion(query: Pick<Query, "interrupt">, { question, earlier, signal }: DriverSideQuestion): Promise<string> {
  if (!("askSideQuestion" in query)) throw new Error("This version of Claude Code can't answer side questions.")
  // SAFETY: the SDK's Query has this method at runtime; its typings omit it.
  const side = query as SideQuestionQuery
  const history = earlier.map((exchange) => ({ question: exchange.question, response: exchange.answer }))
  const answer = SideAnswerSchema.parse(await side.askSideQuestion(question, { history, signal }))
  // `null`: the session has nothing to answer from yet.
  if (!answer?.response) throw new Error("Send a message first, then ask a side question.")
  return answer.response
}

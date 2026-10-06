import { z } from "zod"
import type { JsonObject } from "../../codex-app-json.js"
import type { AcpVendorRequest } from "../acp-source.js"

/**
 * Grok's question card, from grok 1.0.44: the model's `ask_user_question`
 * tool sends the client `_x.ai/ask_user_question` with the questions and
 * waits. Its response `AskUserQuestionExtResponse` is tagged by `outcome`, as
 * the plan request's is: `accepted` with `answers` and `annotations`, or
 * `chat_about_this` and `skip_interview` with `partial_answers`. Answers are
 * keyed by the question's text, several picks joined, as Claude Code's are.
 */
export const GROK_QUESTION_METHOD = "_x.ai/ask_user_question"

const QuestionRequestSchema = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  questions: z.array(z.object({
    question: z.string().min(1),
    options: z.array(z.object({ label: z.string(), description: z.string().nullish() })).max(26),
    multiSelect: z.boolean().nullish(),
  })).min(1).max(10),
})

export function questionRequest(params: JsonObject): AcpVendorRequest | undefined {
  const parsed = QuestionRequestSchema.safeParse(params)
  if (!parsed.success) return undefined
  const { sessionId, questions } = parsed.data
  return {
    sessionId,
    updates: [],
    ask: {
      request: {
        title: "Grok has a question",
        options: [],
        questions: questions.map((question, index) => ({
          id: String(index),
          header: questions.length > 1 ? `Question ${index + 1}` : "Question",
          question: question.question,
          isSecret: false,
          allowOther: true,
          required: true,
          valueType: question.multiSelect ? "string-array" : "string",
          options: question.options.map((option) => ({ label: option.label, description: option.description ?? "" })),
        })),
      },
      answered: (answers) => ({
        outcome: "accepted",
        answers: Object.fromEntries(questions.map((question, index) => [question.question, (answers[String(index)] ?? []).join(", ")])),
        annotations: {},
      }),
      dismissed: { outcome: "skip_interview", partial_answers: {} },
    },
  }
}

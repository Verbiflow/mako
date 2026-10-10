import { z } from "zod"
import type { NativeQuestion, NativeQuestionAnswer } from "../../contracts/live-questions.js"

export const CodexAsyncQuestionsSchema = z.array(z.object({
  title: z.string().min(1),
  options: z.array(z.string().min(1)).min(1).nullish(),
})).min(1).max(100)
export type CodexAsyncQuestion = z.infer<typeof CodexAsyncQuestionsSchema>[number]

export function codexAsyncQuestion(sessionId: string, turnId: string, itemId: string, questions: CodexAsyncQuestion[]): NativeQuestion {
  return { sessionId, turnId, itemId, questions: questions.map((question, index) => ({
    id: JSON.stringify(["request_user_input_async", itemId, index]),
    header: "", question: question.title, isSecret: false, allowOther: true,
    defaultValues: question.options?.slice(0, 1),
    options: (question.options ?? []).map(label => ({ label, description: "" })),
  })) }
}

/** The native desktop/core envelope, sent through normal turn input or steering. */
export function codexQuestionAnswer(question: NativeQuestion, answers: Record<string, string[]>): string {
  const replies = question.questions.map(item => ({
    questionItemId: item.id,
    question: nativeTitle(item.question),
    answer: answers[item.id]!.join("\n"),
  }))
  return `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`
}

function nativeTitle(title: string): string {
  let bytes = 0
  let result = ""
  for (const character of title) {
    bytes += Buffer.byteLength(character)
    if (bytes > 512) break
    result += character
  }
  return result.replace(/[\r\n]/g, " ")
}

const ReplyQuestions = z.array(z.object({ questionItemId: z.string(), answer: z.string(), question: z.string() }))
const QuestionItem = z.tuple([z.literal("request_user_input_async"), z.string().min(1), z.number().int().nonnegative()])

/** Only an exact native reply envelope retires questions, never similar prose. */
export function codexAnsweredQuestions(sessionId: string, text: string): NativeQuestionAnswer[] {
  const body = text.trim().replace(/^<mako-local-control>\n[\s\S]*?\n<\/mako-local-control>\n\n/, "")
  const envelope = /^<send_user_message_question_reply>\s*([\s\S]+?)\s*<\/send_user_message_question_reply>$/.exec(body)
  if (!envelope) return []
  try {
    const replies = ReplyQuestions.parse(JSON.parse(envelope[1]!))
    const items = new Map<string, string[]>()
    for (const reply of replies) {
      const identity = QuestionItem.parse(JSON.parse(reply.questionItemId))
      items.set(identity[1], [...(items.get(identity[1]) ?? []), reply.questionItemId])
    }
    return [...items].map(([itemId, questionIds]) => ({ sessionId, itemId, questionIds }))
  } catch { return [] }
}

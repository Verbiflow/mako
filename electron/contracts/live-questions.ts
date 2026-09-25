import { z } from "zod"
import type { ConversationControl } from "./conversation-control.js"
import type { LiveRequest } from "./live-conversations.js"

export const LiveInputQuestionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  isSecret: z.boolean(),
  allowOther: z.boolean(),
  required: z.boolean().optional(),
  valueType: z
    .enum(["string", "number", "integer", "boolean", "string-array"])
    .optional(),
  options: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
      value: z.string().optional(),
    })
  ),
  defaultValues: z.array(z.string()).optional(),
  when: z.array(z.object({ key: z.string(), op: z.enum(["eq", "neq"]), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
})
export type LiveInputQuestion = z.infer<typeof LiveInputQuestionSchema>

/** Only answered, visible predecessors participate in dependent questions. */
export function activeInputQuestions(questions: readonly LiveInputQuestion[], answers: Record<string, string[]>): LiveInputQuestion[] {
  const visible: LiveInputQuestion[] = []
  const available: Record<string, string[]> = {}
  for (const question of questions) {
    if (question.when?.some(condition => {
      const values = available[condition.key]
      return !values?.length || (condition.op === "eq" ? !values.includes(String(condition.value)) : values.includes(String(condition.value)))
    })) continue
    visible.push(question)
    available[question.id] = answers[question.id] ?? []
  }
  return visible
}

/** Session-lived questions use native message identity, not a callback lifetime. */
export const NativeQuestionSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  questions: z.array(LiveInputQuestionSchema).min(1).max(100),
}).refine(value => new Set(value.questions.map(question => question.id)).size === value.questions.length, "Question IDs must be unique")
export type NativeQuestion = z.infer<typeof NativeQuestionSchema>
export const LiveQuestionSchema = z.object({
  id: z.string().uuid(),
  bindingId: z.string().uuid(),
  native: NativeQuestionSchema,
  dismissed: z.boolean().optional(),
  /** No longer a current prompt after the user moved on; not native cancellation. */
  retired: z.literal(true).optional(),
  answered: z.array(z.string()).optional(),
})
export const NativeQuestionAnswerSchema = z.object({
  sessionId: z.string().min(1), itemId: z.string().min(1), questionIds: z.array(z.string()).min(1),
})
export type NativeQuestionAnswer = z.infer<typeof NativeQuestionAnswerSchema>
export type LiveQuestion = z.infer<typeof LiveQuestionSchema>

/** Positive evidence after complete source catch-up; absence never retires a question. */
export const NativeQuestionHistorySchema = z.array(z.object({
  question: NativeQuestionSchema,
  answered: z.array(z.string()),
  retired: z.literal(true).optional(),
})).max(2000)
export type NativeQuestionHistory = z.infer<typeof NativeQuestionHistorySchema>

function unanswered(question: LiveQuestion, bindingId: string): boolean {
  return !question.dismissed && !question.retired && question.bindingId === bindingId && question.native.questions.some(item => !question.answered?.includes(item.id))
}

/** Retire only the questions seen when ordinary input was accepted. Answers keep other questions. */
export function retireQuestionsForInput(control: ConversationControl, inputId: string, observed = control.questions): ConversationControl {
  if (!observed?.length || control.questions?.some(question => question.id === inputId)) return control
  const ids = new Set(observed.filter(question => unanswered(question, control.activeBindingId)).map(question => question.id))
  if (!ids.size) return control
  return { ...control, questions: control.questions?.map(question => ids.has(question.id) ? { ...question, retired: true } : question) }
}

/** Build answer ownership once, rather than scanning all history per question. */
export function latestPendingQuestion(control: ConversationControl, requests: readonly LiveRequest[]): LiveQuestion | undefined {
  const questions = control.questions
  if (!questions?.length) return undefined
  const owned = new Set([
    ...requests.map(request => request.id),
    ...(control.actions ?? []).filter(action => action.state.kind !== "not-accepted").map(action => action.input.id),
    ...control.transfers.map(transfer => transfer.input.id),
  ])
  for (let index = questions.length - 1; index >= 0; index--) {
    const question = questions[index]!
    if (unanswered(question, control.activeBindingId) && !owned.has(question.id)) return question
  }
  return undefined
}

export function pendingQuestion(question: LiveQuestion, control: ConversationControl, requests: readonly LiveRequest[]): boolean {
  return unanswered(question, control.activeBindingId) &&
    !requests.some(request => request.id === question.id) &&
    !control.actions?.some(action => action.input.id === question.id && action.state.kind !== "not-accepted") &&
    !control.transfers.some(transfer => transfer.input.id === question.id)
}

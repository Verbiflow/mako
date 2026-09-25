import { z } from "zod"
import type { LiveInputQuestion, LivePermissionResponse } from "../../shared.js"
import { approvalAnswerDigest } from "../approval-evidence.js"
import { activeInputQuestions } from "../../contracts/live-questions.js"

const Option = z.object({ value: z.string(), label: z.string(), description: z.string().optional() })
const Field = z.object({
  key: z.string(), title: z.string().optional(), description: z.string().optional(), required: z.boolean().optional(),
  type: z.enum(["string", "number", "integer", "boolean", "multiselect"]),
  options: z.array(Option).optional(), custom: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  when: z.array(z.object({ key: z.string(), op: z.enum(["eq", "neq"]), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
})
export const NativeForm = z.object({ id: z.string().min(1).max(512), sessionID: z.string().min(1).max(512), title: z.string(), fields: z.array(Field).min(1).max(100) })
export const NativeFormAnswer = z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]))
export function openCodeQuestions(raw: unknown): LiveInputQuestion[] {
  return NativeForm.parse(raw).fields.map(field => {
    const options = field.type === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : field.options ?? []
    return {
      id: field.key, header: field.title ?? field.key, question: field.description ?? field.title ?? field.key,
      isSecret: false, required: field.required ?? false,
      allowOther: field.type !== "boolean" && (!field.options?.length || field.custom === true),
      valueType: field.type === "multiselect" ? "string-array" : field.type,
      options: options.map(option => ({ ...option, description: "description" in option ? option.description ?? "" : "",
        label: options.filter(other => other.label === option.label).length > 1 ? `${option.label} (${option.value})` : option.label })),
      defaultValues: field.default === undefined ? undefined : Array.isArray(field.default) ? field.default : [String(field.default)],
      when: field.when,
    }
  })
}
export function openCodeFormAnswer(questions: readonly LiveInputQuestion[], response: LivePermissionResponse): z.infer<typeof NativeFormAnswer> | undefined {
  if (response.kind !== "answers") return undefined
  const result: z.infer<typeof NativeFormAnswer> = {}
  for (const question of activeInputQuestions(questions, response.answers)) {
    const values = response.answers[question.id] ?? []
    if (!values.length) { if (question.required) throw new Error("Answer the required question"); continue }
    if (question.valueType === "string-array") result[question.id] = values
    else if (values.length !== 1) throw new Error("This question requires one answer")
    else if (question.valueType === "boolean") {
      if (!['true', 'false'].includes(values[0])) throw new Error("Invalid boolean answer")
      result[question.id] = values[0] === "true"
    } else if (question.valueType === "number" || question.valueType === "integer") {
      const value = Number(values[0])
      if (!values[0].trim() || !Number.isFinite(value) || (question.valueType === "integer" && !Number.isInteger(value))) throw new Error("Invalid numeric answer")
      result[question.id] = value
    } else result[question.id] = values[0]
  }
  return result
}
export function openCodeAnswerDigest(raw: unknown): string {
  const answer = NativeFormAnswer.parse(raw)
  return approvalAnswerDigest({ kind: "answers", answers: Object.fromEntries(Object.entries(answer).map(([key, value]) => [key, Array.isArray(value) ? value : [String(value)]])) })
}

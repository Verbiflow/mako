import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { CreateElicitationRequest as ElicitationRequest, type CreateElicitationRequest, type SessionNotification } from "@agentclientprotocol/sdk"
import type { NativeApprovalDecision, NativeApprovalIdentity } from "../../contracts/approval-response.js"
import { elicitationQuestion } from "../../acp-elicitation.js"
import type { AcpApprovalObserver } from "../acp-source.js"
import { approvalAnswerDigest } from "../approval-evidence.js"

const questionsSchema = z.array(z.object({ question: z.string(), header: z.string(), options: z.array(z.string()) })).min(1).max(10)
const answersSchema = z.array(z.object({ question_index: z.number().int().nonnegative(), selected_options: z.array(z.string()) })).min(1).max(10)
const storedAnswersSchema = z.object({ answers: z.array(z.object({ question_index: z.number().int().nonnegative(), selected: z.array(z.string()) })).min(1).max(10) })
const metaSchema = z.object({
  "cognition.ai/inferenceToolName": z.literal("ask_user_question"),
  "cognition.ai/questions": questionsSchema.optional(),
  "cognition.ai/answers": answersSchema.optional(),
})
const messageSchema = z.object({
  role: z.string(), tool_call_id: z.string().optional(),
  tool_calls: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  metadata: z.object({ extensions: z.record(z.string(), z.unknown()).optional() }).optional(),
})
const nodeSchema = z.object({ node_id: z.number().int(), parent_node_id: z.number().int().nullable(), chat_message: z.string() })
const occurrenceKey = (sessionId: string, requestId: string) => JSON.stringify([sessionId, requestId])

function answerDigest(answers: z.infer<typeof answersSchema>): string | undefined {
  // An incomplete/skipped or duplicate answer is not evidence of the submitted form.
  const sorted = [...answers].sort((a, b) => a.question_index - b.question_index)
  if (sorted.some((answer, index) => answer.question_index !== index || !answer.selected_options.length)) return
  return approvalAnswerDigest({ kind: "answers", answers: Object.fromEntries(sorted.map(a => [`q${a.question_index}`, a.selected_options])) })
}

/** Only the selected branch is authoritative. No rendered prose, status, or answer echo. */
export function readDevinApprovalDecisions(path: string, previous: readonly NativeApprovalIdentity[]): NativeApprovalDecision[] {
  const separator = path.lastIndexOf("#")
  if (separator < 0) return []
  const sessionId = path.slice(separator + 1)
  const identities = previous.filter(identity => identity.sessionId === sessionId)
  if (!identities.length) return []
  const database = new DatabaseSync(path.slice(0, separator), { readOnly: true })
  try {
    database.exec("BEGIN")
    const session = z.object({ main_chain_id: z.number().int().nullable() }).parse(database.prepare("SELECT main_chain_id FROM sessions WHERE id = ? AND hidden = 0").get(sessionId))
    const statement = database.prepare("SELECT node_id, parent_node_id, chat_message FROM message_nodes WHERE session_id = ? AND node_id = ?")
    const visited = new Set<number>()
    const calls = new Map<string, number>()
    const results = new Map<string, string[]>()
    let next = session.main_chain_id
    while (next !== null) {
      if (visited.has(next)) throw new Error("Devin's native question history contains a cycle")
      visited.add(next)
      const node = nodeSchema.parse(statement.get(sessionId, next))
      const message = messageSchema.parse(JSON.parse(node.chat_message))
      for (const call of message.role === "assistant" ? message.tool_calls ?? [] : []) {
        if (call.name === "ask_user_question") calls.set(call.id, (calls.get(call.id) ?? 0) + 1)
      }
      if (message.role === "tool" && message.tool_call_id) {
        const answers = storedAnswersSchema.safeParse(message.metadata?.extensions?.["chisel/user_question_answers"])
        if (answers.success) {
          const digest = answerDigest(answers.data.answers.map(a => ({ question_index: a.question_index, selected_options: a.selected })))
          const values = results.get(message.tool_call_id) ?? []
          values.push(digest ?? "")
          results.set(message.tool_call_id, values)
        }
      }
      next = node.parent_node_id
    }
    return identities.flatMap(identity => {
      const values = results.get(identity.requestId)
      if (identities.filter(i => i.requestId === identity.requestId).length !== 1 || calls.get(identity.requestId) !== 1 || values?.length !== 1 || !values[0]) return []
      return [{ identity, answerDigest: values[0], observedAt: Date.now() }]
    })
  } finally { database.close() }
}

export class DevinApprovalObserver implements AcpApprovalObserver {
  private readonly scope = randomUUID()
  private readonly pending = new Map<string, { sessionId: string; requestId: string; questions: z.infer<typeof questionsSchema>; identity?: NativeApprovalIdentity }>()
  private readonly previous = new Map<string, NativeApprovalIdentity | null>()
  private readonly seen = new Set<string>()
  private readonly publish: (decision: NativeApprovalDecision) => void
  constructor(publish: (decision: NativeApprovalDecision) => void, previous: readonly NativeApprovalIdentity[]) {
    this.publish = publish
    for (const identity of previous) {
      const key = occurrenceKey(identity.sessionId, identity.requestId)
      this.previous.set(key, this.previous.has(key) ? null : identity)
    }
  }
  async identify(): Promise<undefined> { return undefined }
  identifyElicitation(request: CreateElicitationRequest): NativeApprovalIdentity | undefined {
    if (!ElicitationRequest.isForm(request) || !("sessionId" in request)) return
    const properties = Object.entries(request.requestedSchema.properties ?? {})
    const questions = properties.map(([id, property], index) => {
      if (id !== `q${index}`) return null
      const question = elicitationQuestion(id, property, request.requestedSchema.required?.includes(id) ?? false)
      return question ? { question: question.question, header: question.header, options: question.options.map(o => o.value ?? o.label) } : null
    })
    const matches = [...this.pending.entries()].filter(([, p]) => p.sessionId === request.sessionId && isDeepStrictEqual(p.questions, questions))
    // ACP omits the tool ID from elicitation. Identical concurrent forms cannot be joined safely.
    if (matches.length !== 1 || matches[0][1].identity) return
    const [key, pending] = matches[0]
    // A replacement callback is still the saved occurrence. Retain ambiguity
    // instead of manufacturing a new identity that bypasses answer-once checks.
    if (this.previous.has(key)) pending.identity = this.previous.get(key) ?? undefined
    else pending.identity = { scope: this.scope, sessionId: pending.sessionId, requestId: pending.requestId }
    return pending.identity
  }
  observe({ sessionId, update }: SessionNotification): void {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return
    const parsed = metaSchema.safeParse(update._meta)
    if (!parsed.success) return
    const meta = parsed.data
    const key = occurrenceKey(sessionId, update.toolCallId)
    if (update.sessionUpdate === "tool_call" && meta["cognition.ai/questions"]) {
      if (this.seen.has(key)) { this.pending.delete(key); return }
      if (this.seen.size >= 2000) return
      this.seen.add(key)
      this.pending.set(key, { sessionId, requestId: update.toolCallId, questions: meta["cognition.ai/questions"] })
    }
    const pending = this.pending.get(key)
    const answers = meta["cognition.ai/answers"]
    if (pending?.sessionId !== sessionId) return
    if (answers && pending.identity) {
      const digest = answers.length === pending.questions.length ? answerDigest(answers) : undefined
      if (digest) this.publish({ identity: pending.identity, answerDigest: digest, observedAt: Date.now() })
      this.pending.delete(key)
    } else if (update.status === "completed" || update.status === "failed") this.pending.delete(key)
  }
  async dispose(): Promise<void> { this.pending.clear(); this.seen.clear(); this.previous.clear() }
}

import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import { z } from "zod"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { readLineBatch } from "@mako/sessions/jsonl"
import type { NativeApprovalDecision, NativeApprovalIdentity } from "../../contracts/approval-response.js"
import type { LivePermissionRequest, LivePermissionResponse } from "../../shared.js"
import { approvalAnswerDigest } from "../approval-evidence.js"

const resultSchema = z.object({ answers: z.record(z.string(), z.string()), questions: z.array(z.object({ question: z.string() })).min(1) })
const contentSchema = z.array(z.object({ type: z.string(), id: z.string().optional(), name: z.string().optional(), tool_use_id: z.string().optional(), is_error: z.boolean().optional() }))
const savedSchema = z.object({
  type: z.string(), sessionId: z.string().optional(), isSidechain: z.boolean().optional(),
  uuid: z.string().optional(), parentUuid: z.string().nullable().optional(), leafUuid: z.string().optional(),
  message: z.object({ content: z.unknown() }).optional(), toolUseResult: z.unknown().optional(),
})
const liveSchema = z.object({ type: z.literal("user"), session_id: z.string(), parent_tool_use_id: z.null(), message: z.object({ content: contentSchema }), tool_use_result: resultSchema })

function resultDigest({ questions, answers }: z.infer<typeof resultSchema>): string | undefined {
  if (new Set(questions.map(q => q.question)).size !== questions.length || Object.keys(answers).length !== questions.length || questions.some(q => !Object.hasOwn(answers, q.question))) return
  return approvalAnswerDigest({ kind: "answers", answers: Object.fromEntries(questions.map(q => [q.question, [answers[q.question]]])) })
}

/** Use precisely Claude's encoding; splitting comma-separated native values would be ambiguous. */
export function claudeApprovalAnswerDigest(request: LivePermissionRequest, response: LivePermissionResponse): string | undefined {
  if (!request.native || !request.questions || response.kind !== "answers") return
  if (new Set(request.questions.map(q => q.question)).size !== request.questions.length || request.questions.some(q => !response.answers[q.id]?.length)) return
  return approvalAnswerDigest({ kind: "answers", answers: Object.fromEntries(request.questions.map(q => [q.question, [response.answers[q.id].join(", ")]])) })
}

export async function readClaudeApprovalDecisions(path: string, sessionId: string, previous: readonly NativeApprovalIdentity[]): Promise<NativeApprovalDecision[]> {
  const identities = previous.filter(p => p.sessionId === sessionId)
  if (!identities.length) return []
  const before = await stat(path)
  const nodes = new Map<string, { parent: string | null; calls: string[]; results: { id: string; digest: string }[] }>()
  let head: string | undefined
  const read = await readLineBatch(path, 0, line => {
    const entry = savedSchema.parse(JSON.parse(line))
    if (entry.isSidechain || entry.sessionId !== sessionId) return
    if (entry.type === "last-prompt") { head = entry.leafUuid; return }
    if (!entry.uuid || entry.parentUuid === undefined) return
    if (nodes.has(entry.uuid)) throw new Error("Claude's native question history repeats a chain entry")
    const content = contentSchema.safeParse(entry.message?.content)
    const calls = content.success ? content.data.filter(b => b.type === "tool_use" && b.name === "AskUserQuestion" && b.id).map(b => b.id!) : []
    const results = content.success ? content.data.filter(b => b.type === "tool_result" && b.tool_use_id && !b.is_error) : []
    const result = resultSchema.safeParse(entry.toolUseResult)
    const digest = result.success ? resultDigest(result.data) : undefined
    nodes.set(entry.uuid, { parent: entry.parentUuid, calls, results: results.length === 1 && digest ? [{ id: results[0].tool_use_id!, digest }] : [] })
  }, { identity: `${before.dev}:${before.ino}`, strict: true })
  const after = await stat(path)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || read.nextByte !== read.size || `${after.dev}:${after.ino}` !== read.identity || !head) return []
  const visited = new Set<string>(), calls = new Map<string, number>(), results = new Map<string, string[]>()
  while (head) {
    if (visited.has(head)) throw new Error("Claude's native question history contains a cycle")
    visited.add(head)
    const node = nodes.get(head)
    if (!node) return []
    for (const id of node.calls) calls.set(id, (calls.get(id) ?? 0) + 1)
    for (const result of node.results) results.set(result.id, [...results.get(result.id) ?? [], result.digest])
    head = node.parent ?? undefined
  }
  return identities.flatMap(identity => {
    const matches = results.get(identity.requestId)
    if (identities.filter(p => p.requestId === identity.requestId).length !== 1 || calls.get(identity.requestId) !== 1 || matches?.length !== 1) return []
    return [{ identity, answerDigest: matches[0], observedAt: Date.now() }]
  })
}

export class ClaudeApprovalObserver {
  private readonly scope = randomUUID()
  private readonly identities = new Map<string, NativeApprovalIdentity | null>()
  private readonly sessionId: string
  private readonly publish: (decision: NativeApprovalDecision) => void
  constructor(sessionId: string, previous: readonly NativeApprovalIdentity[], publish: (decision: NativeApprovalDecision) => void) {
    this.sessionId = sessionId
    this.publish = publish
    for (const identity of previous) if (identity.sessionId === sessionId)
      this.identities.set(identity.requestId, this.identities.has(identity.requestId) ? null : identity)
  }
  identify(toolUseId: string): NativeApprovalIdentity | undefined {
    if (this.identities.has(toolUseId)) return this.identities.get(toolUseId) ?? undefined
    if (this.identities.size >= 2000) return
    const identity = { scope: this.scope, sessionId: this.sessionId, requestId: toolUseId }
    this.identities.set(toolUseId, identity)
    return identity
  }
  observe(message: SDKMessage): void {
    const parsed = liveSchema.safeParse(message)
    if (!parsed.success || parsed.data.session_id !== this.sessionId) return
    const results = parsed.data.message.content.filter(b => b.type === "tool_result" && b.tool_use_id && !b.is_error)
    if (results.length !== 1) return
    const identity = this.identities.get(results[0].tool_use_id!)
    const digest = resultDigest(parsed.data.tool_use_result)
    if (identity && digest) this.publish({ identity, answerDigest: digest, observedAt: Date.now() })
  }
}

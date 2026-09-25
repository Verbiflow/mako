import { z } from "zod"
import { LineAssembler } from "@mako/sessions"
import type { NativeApprovalDecision, NativeApprovalIdentity } from "../../contracts/approval-response.js"
import type { LivePermissionResponse } from "../../shared.js"
import { approvalAnswerDigest } from "../approval-evidence.js"
import { RetainedApprovalDecisions, readRetainedApprovalDecisions } from "../retained-approval-decisions.js"

const Decision = z.object({
  "event.name": z.literal("codex.tool_decision"),
  "event.timestamp": z.string().datetime(),
  "conversation.id": z.string().min(1).max(512),
  call_id: z.string().min(1).max(512),
  decision: z.enum(["approved", "approved_for_session", "denied", "abort"]),
  source: z.literal("User"),
})
const Log = z.object({ target: z.string().optional(), level: z.string().optional(), fields: z.looseObject({ message: z.string().optional() }) })
const SimpleChoice = z.enum(["accept", "acceptForSession", "decline", "cancel"])
const decisions = new Map([
  ["accept", "approved"], ["acceptForSession", "approved_for_session"],
  ["decline", "denied"], ["cancel", "abort"],
])
export interface CodexApprovalCall { threadId: string; itemId: string }
export interface CodexApprovalChoice { optionId: string; result: { decision: unknown } }
interface Occurrence {
  identity: NativeApprovalIdentity
  registeredAt: number
  choices: Map<string, string>
  submitted: boolean
  published: boolean
}

/** Local structured native logs leave Codex's configured telemetry exporters
 * untouched. Only exact user decisions become shared, durable receipts. */
export function codexApprovalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, LOG_FORMAT: "json", RUST_LOG: `${env.RUST_LOG || "error"},codex_otel.log_only=info` }
}

export class CodexPermissionObserver {
  private readonly retained: RetainedApprovalDecisions
  private readonly calls = new Map<string, Occurrence | null>()
  private readonly previous = new Set<string>()
  private readonly lines = new LineAssembler(256 * 1024)
  private disabled = false
  private pending = Promise.resolve()
  private closing?: Promise<void>
  private readonly publish: (decision: NativeApprovalDecision) => void

  constructor(root: string, previous: readonly NativeApprovalIdentity[], publish: (decision: NativeApprovalDecision) => void) {
    this.publish = publish
    this.retained = new RetainedApprovalDecisions(root)
    for (const identity of previous) {
      const key = this.key(identity.sessionId, identity.requestId)
      this.previous.add(key)
    }
    this.pending = readRetainedApprovalDecisions(root, previous).then(records => {
      for (const record of records) publish(record)
    }).catch(() => { this.disabled = true })
  }

  identify(call: CodexApprovalCall, choices: readonly CodexApprovalChoice[]): NativeApprovalIdentity | undefined {
    if (this.disabled || this.closing || !call.threadId || !call.itemId || call.threadId.length > 512 || call.itemId.length > 512) return
    const key = this.key(call.threadId, call.itemId)
    // A new callback using an old tool ID might be another approval for that
    // tool. Do not attach its old receipt identity and hide a newer question.
    if (this.previous.has(key)) return
    // Native telemetry omits approvalId and turnId. Once a tool asks twice,
    // neither a late event nor the latest callback can disambiguate its choice.
    if (this.calls.has(key)) { this.calls.set(key, null); return }
    if (this.calls.size >= 2000) return
    const identity = { scope: this.retained.scope, sessionId: call.threadId, requestId: call.itemId }
    const mapped = new Map<string, string>()
    for (const choice of choices) {
      const choiceValue = SimpleChoice.safeParse(choice.result.decision)
      const decision = choiceValue.success ? decisions.get(choiceValue.data) : undefined
      if (decision) {
        if (mapped.has(decision)) { this.calls.set(key, null); return }
        mapped.set(decision, approvalAnswerDigest({ kind: "choice", optionId: choice.optionId }))
      }
    }
    this.calls.set(key, { identity, registeredAt: Date.now(), choices: mapped, submitted: false, published: false })
    return identity
  }

  submitted(identity: NativeApprovalIdentity | undefined, response: LivePermissionResponse): void {
    if (!identity) return
    const occurrence = this.calls.get(this.key(identity.sessionId, identity.requestId))
    if (!occurrence || occurrence.identity !== identity || occurrence.submitted) return
    occurrence.submitted = true
    if (response.kind === "choice" && response.optionId === null)
      occurrence.choices.set("abort", approvalAnswerDigest(response))
  }

  /** Discard telemetry envelopes (including account and prompt fields) before
   * they can enter startup diagnostics. Bound both buffering and retained work. */
  stderr(chunk: Buffer): string {
    if (this.disabled || this.closing) return ""
    const lines = this.lines.push(chunk)
    if (!lines) { this.disabled = true; return "Codex diagnostic line exceeded the observation limit.\n" }
    let diagnostic = ""
    for (const line of lines) {
      let raw: unknown
      try { raw = JSON.parse(line) } catch {
        if (!line.trimStart().startsWith("{")) diagnostic += line + "\n"
        continue
      }
      const parsed = Log.safeParse(raw)
      if (!parsed.success) continue
      const log = parsed.data
      if (log.target === "codex_otel.log_only") {
        const parsedDecision = Decision.safeParse(log.fields)
        if (parsedDecision.success) this.observe(parsedDecision.data)
      } else if ((log.level === "ERROR" || log.level === "WARN") && log.fields.message !== undefined) {
        diagnostic += log.fields.message + "\n"
      }
    }
    return diagnostic.slice(-16 * 1024)
  }

  private observe(event: z.infer<typeof Decision>): void {
    const key = this.key(event["conversation.id"], event.call_id)
    const occurrence = this.calls.get(key)
    const observedAt = Date.parse(event["event.timestamp"])
    if (!occurrence || !occurrence.submitted || occurrence.published || observedAt < occurrence.registeredAt) return
    const answerDigest = occurrence.choices.get(event.decision)
    if (!answerDigest) return
    occurrence.published = true
    this.pending = this.pending.then(async () => {
      if (this.disabled || this.calls.get(key) !== occurrence) return
      const decision = await this.retained.record({ identity: occurrence.identity, answerDigest, observedAt })
      if (this.calls.get(key) === occurrence) this.publish(decision)
    }).catch(() => { this.disabled = true })
  }

  close(): Promise<void> {
    return this.closing ??= this.pending.finally(() => this.retained.close())
  }

  private key(sessionId: string, requestId: string): string { return JSON.stringify([sessionId, requestId]) }
}

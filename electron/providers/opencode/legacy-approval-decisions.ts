import { open } from "node:fs/promises"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { z } from "zod"
import { NativeApprovalIdentitySchema, type NativeApprovalIdentity, type NativeApprovalDecision } from "../../contracts/approval-response.js"
import { approvalAnswerDigest } from "../approval-evidence.js"

const id = z.string().min(1).max(512)
const Record = z.discriminatedUnion("type", [
  z.object({ type: z.literal("asked"), sessionId: id, requestId: id, toolId: id }),
  z.object({ type: z.literal("replied"), sessionId: id, requestId: id, reply: z.enum(["once", "always", "reject"]), observedAt: z.number().finite() }),
])
type Record = z.infer<typeof Record>
const key = (sessionId: string, requestId: string) => JSON.stringify([sessionId, requestId])

/** Bounded incremental reader; partial records and malformed evidence never confirm an answer. */
class EvidenceLog {
  readonly asked = new Map<string, Extract<Record, { type: "asked" }>>()
  readonly replied = new Map<string, Extract<Record, { type: "replied" }>>()
  readonly ambiguous = new Set<string>()
  private offset = 0
  private pending = ""
  private reading?: Promise<void>
  private invalid = false
  private readonly decoder = new StringDecoder("utf8")
  private readonly path: string
  constructor(path: string) { this.path = path }
  get bytesRead(): number { return this.offset }
  read(): Promise<void> {
    return this.reading ??= this.scan().finally(() => { this.reading = undefined })
  }
  private async scan(): Promise<void> {
    if (this.invalid) return
    const file = await open(this.path, "r").catch(() => undefined)
    if (!file) return
    try {
      const stat = await file.stat()
      if (stat.size < this.offset || stat.size > 1_048_576) { this.invalid = true; this.asked.clear(); this.replied.clear(); return }
      const buffer = Buffer.alloc(16_384)
      while (this.offset < stat.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset)
        if (!bytesRead) break
        this.offset += bytesRead
        const lines = (this.pending + this.decoder.write(buffer.subarray(0, bytesRead))).split("\n")
        this.pending = lines.pop() ?? ""
        if (this.pending.length > 4096) throw new Error("Oversized native approval evidence")
        for (const line of lines) {
          if (line.length > 4096) throw new Error("Oversized native approval evidence")
          const record = Record.parse(JSON.parse(line))
          const identity = key(record.sessionId, record.requestId)
          if (record.type === "asked") {
            if (this.asked.has(identity)) this.ambiguous.add(identity)
            this.asked.set(identity, record)
          } else {
            const previous = this.replied.get(identity)
            if (previous && previous.reply !== record.reply) this.ambiguous.add(identity)
            this.replied.set(identity, record)
          }
        }
      }
    } catch { this.invalid = true; this.asked.clear(); this.replied.clear() }
    finally { await file.close() }
  }
}

function decisionFrom(log: EvidenceLog, identity: NativeApprovalIdentity): NativeApprovalDecision | undefined {
  const k = key(identity.sessionId, identity.requestId)
  const reply = log.replied.get(k)
  if (!reply || !log.asked.has(k) || log.ambiguous.has(k)) return undefined
  return { identity, observedAt: reply.observedAt, answerDigest: approvalAnswerDigest({ kind: "choice", optionId: reply.reply }) }
}

/** Read-only upgrade compatibility for evidence produced by retired ACP plugins. */
export async function readLegacyOpenCodeDecisions(root: string, previousIdentities: readonly NativeApprovalIdentity[]): Promise<NativeApprovalDecision[]> {
  const decisions: NativeApprovalDecision[] = []
  // Only saved exact occurrences are revisited. Missing files never imply rejection or success.
  const previous = new Map<string, NativeApprovalIdentity[]>()
  for (const value of previousIdentities) {
    const identity = NativeApprovalIdentitySchema.parse(value)
    const group = previous.get(identity.scope) ?? []
    group.push(identity)
    previous.set(identity.scope, group)
  }
  let remaining = 8 * 1_048_576
  for (const [scope, identities] of previous) {
    if (remaining < 1_048_576) break
    const log = new EvidenceLog(join(root, scope, "events.jsonl"))
    await log.read()
    remaining -= log.bytesRead
    for (const identity of identities) {
      const decision = decisionFrom(log, identity)
      if (decision) decisions.push(decision)
    }
  }
  return decisions
}

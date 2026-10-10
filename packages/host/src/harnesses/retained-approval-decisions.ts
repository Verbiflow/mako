import { randomUUID } from "node:crypto"
import { mkdir, open, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { NativeApprovalDecisionSchema, NativeApprovalIdentitySchema, sameNativeApproval, type NativeApprovalDecision, type NativeApprovalIdentity } from "../contracts/approval-response.js"

const MAX_BYTES = 2 * 1024 * 1024

/** For adapters whose native decision stream has no retained history. Stores only
 * normalized evidence, never prompts, tool input, credentials or answer text.
 * Native wire parsing remains the adapter's responsibility. */
export class RetainedApprovalDecisions {
  readonly scope = randomUUID()
  private file?: FileHandle
  private bytes = 0
  private failure = false
  private closed = false
  private pending = Promise.resolve()
  private readonly recorded = new Map<string, NativeApprovalDecision>()
  private readonly root: string
  constructor(root: string) { this.root = root }

  record(raw: NativeApprovalDecision): Promise<NativeApprovalDecision> {
    const decision = NativeApprovalDecisionSchema.parse(raw)
    if (decision.identity.scope !== this.scope || this.closed) return Promise.reject(new Error("Approval observer is no longer current"))
    const operation = this.pending.then(async () => {
      if (this.failure) throw new Error("Approval evidence storage is unavailable")
      const key = JSON.stringify([decision.identity.sessionId, decision.identity.requestId])
      const prior = this.recorded.get(key)
      if (prior) {
        if (prior.answerDigest !== decision.answerDigest) throw new Error("Native approval evidence conflicts")
        return prior
      }
      const line = JSON.stringify(decision) + "\n"
      const size = Buffer.byteLength(line)
      if (this.recorded.size >= 2000 || this.bytes + size > MAX_BYTES) throw new Error("Approval evidence capacity reached")
      if (!this.file) {
        await mkdir(this.root, { recursive: true, mode: 0o700 })
        this.file = await open(join(this.root, `${this.scope}.jsonl`), "wx", 0o600)
      }
      await this.file.writeFile(line)
      await this.file.sync()
      this.bytes += size
      this.recorded.set(key, decision)
      return decision
    })
    this.pending = operation.then(() => {}, () => { this.failure = true })
    return operation
  }

  async close(): Promise<void> {
    this.closed = true
    await this.pending
    await this.file?.close()
    this.file = undefined
  }
}

/** Revisit only journaled occurrences, within a bounded read budget. A missing,
 * truncated or conflicting record cannot turn uncertainty into confirmation. */
export async function readRetainedApprovalDecisions(root: string, previous: readonly NativeApprovalIdentity[]): Promise<NativeApprovalDecision[]> {
  const groups = new Map<string, NativeApprovalIdentity[]>()
  for (const raw of previous.slice(0, 2000)) {
    const identity = NativeApprovalIdentitySchema.parse(raw)
    groups.set(identity.scope, [...groups.get(identity.scope) ?? [], identity])
  }
  const decisions: NativeApprovalDecision[] = []
  let budget = 8 * MAX_BYTES
  for (const [scope, identities] of groups) {
    if (budget <= 0) break
    const file = await open(join(root, `${scope}.jsonl`), "r").catch(() => undefined)
    if (!file) continue
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > MAX_BYTES || stat.size > budget) continue
      budget -= stat.size
      const bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      const text = bytes.subarray(0, offset).toString("utf8")
      const records = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => NativeApprovalDecisionSchema.parse(JSON.parse(line)))
      if (records.some(record => record.identity.scope !== scope)) continue
      for (const identity of identities) {
        const matches = records.filter(record => sameNativeApproval(record.identity, identity))
        if (matches.length && matches.every(record => record.answerDigest === matches[0].answerDigest)) decisions.push(matches[0])
      }
    } catch { /* Unreadable native evidence stays unconfirmed. */ }
    finally { await file.close() }
  }
  return decisions
}

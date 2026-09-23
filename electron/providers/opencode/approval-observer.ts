import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, writeFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { StringDecoder } from "node:string_decoder"
import { z } from "zod"
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk"
import { NativeApprovalIdentitySchema, type NativeApprovalIdentity, type NativeApprovalDecision } from "../../contracts/approval-response.js"
import { approvalAnswerDigest } from "../approval-evidence.js"
import type { AcpApprovalObserver, AcpLaunch } from "../acp-source.js"

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

class OpenCodeApprovalObserver implements AcpApprovalObserver {
  private readonly claimed = new Set<string>()
  private readonly waiting = new Map<string, NativeApprovalIdentity>()
  private readonly log: EvidenceLog
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private readonly scope: string
  private readonly publish: (decision: NativeApprovalDecision) => void
  constructor(scope: string, path: string, publish: (decision: NativeApprovalDecision) => void) {
    this.scope = scope
    this.publish = publish
    this.log = new EvidenceLog(path)
  }
  async identify(request: RequestPermissionRequest): Promise<NativeApprovalIdentity | undefined> {
    const deadline = Date.now() + 1000
    while (!this.stopped) {
      await this.log.read()
      if (this.stopped) return undefined
      const candidates = [...this.log.asked.entries()].filter(([k, item]) => !this.claimed.has(k) && !this.log.replied.has(k) &&
        ((item.sessionId === request.sessionId && item.toolId === request.toolCall.toolCallId) ||
          `${item.sessionId}:${item.toolId}` === request.toolCall.toolCallId))
      if (candidates.length > 1) return undefined
      const match = candidates[0]
      if (match) {
        const [k, item] = match
        if (this.log.ambiguous.has(k)) return undefined
        this.claimed.add(k)
        const identity = { scope: this.scope, sessionId: item.sessionId, requestId: item.requestId }
        this.waiting.set(k, identity)
        this.schedule()
        return identity
      }
      if (Date.now() >= deadline) return undefined
      await delay(20)
    }
  }
  private schedule(): void {
    if (this.stopped || this.timer || !this.waiting.size) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.scan().catch(() => {}).finally(() => this.schedule()) }, 250)
    this.timer.unref()
  }
  private async scan(): Promise<void> {
    await this.log.read()
    for (const [k, identity] of this.waiting) {
      const decision = decisionFrom(this.log, identity)
      if (!decision) continue
      this.publish(decision)
      this.waiting.delete(k)
    }
  }
  async dispose(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.scan()
  }
}

function decisionFrom(log: EvidenceLog, identity: NativeApprovalIdentity): NativeApprovalDecision | undefined {
  const k = key(identity.sessionId, identity.requestId)
  const reply = log.replied.get(k)
  if (!reply || !log.asked.has(k) || log.ambiguous.has(k)) return undefined
  return { identity, observedAt: reply.observedAt, answerDigest: approvalAnswerDigest({ kind: "choice", optionId: reply.reply }) }
}

export const prepareOpenCodeApprovals: NonNullable<AcpLaunch["prepareApprovals"]> = async input => {
  const root = join(input.root, "opencode")
  const scope = randomUUID()
  const directory = join(root, scope)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, "events.jsonl")
  await writeFile(path, "", { mode: 0o600, flag: "wx" })
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module", main: "index.js" }), { mode: 0o600 })
  await writeFile(join(directory, "index.js"), await readFile(new URL("./native-approval-plugin.bundle.mjs", import.meta.url)), { mode: 0o600 })
  const config = z.looseObject({ plugins: z.array(z.unknown()).optional() }).parse(JSON.parse(input.env.OPENCODE_CONFIG_CONTENT || "{}"))
  input.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, plugins: [...(config.plugins ?? []), { package: directory, options: { path } }] })
  // Only saved exact occurrences are revisited. Missing files never imply rejection or success.
  const previous = new Map<string, NativeApprovalIdentity[]>()
  for (const value of input.previous) {
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
      if (decision) input.publish(decision)
    }
  }
  const observer = new OpenCodeApprovalObserver(scope, path, input.publish)
  return {
    identify: request => observer.identify(request),
    async dispose() {
      await observer.dispose()
      // Keep the evidence for journal reconciliation, not another copy of the plugin.
      await Promise.all(["index.js", "package.json"].map(name => unlink(join(directory, name)).catch(() => {})))
    },
  }
}

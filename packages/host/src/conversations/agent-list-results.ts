import { createHash, randomUUID } from "node:crypto"
import type { AgentCaller, AgentRefused, FinPullRequest } from "../contracts/agents.js"
import type { AgentsListModelResult, AgentsListResult, AgentsPullsReadResult, AgentsReadInput, AgentsReadResult } from "../contracts/agent-tools.js"

const INLINE_PULLS = 2
/** Reserve the count/expiry/recovery envelope before replacing an inline array. */
const SUMMARY_BYTES = 384
const PAGE_SIZE = 20
const PAGE_BYTES = 16_000
const SNAPSHOT_MS = 30 * 60_000
const SNAPSHOT_BYTES = 2 * 1024 * 1024
const SNAPSHOT_COUNT = 32

interface Snapshot {
  owner: string
  digest: string
  expiresAt: number
  bytes: number
  children: ReadonlyMap<string, readonly FinPullRequest[]>
}

/** Explicit summary's volatile PR details. Default output stays full; this is no durable payload store. */
export class AgentListResults {
  private readonly snapshots = new Map<string, Snapshot>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** Only large PR arrays change; every identity, state, question, wait and unknown field stays as it was. */
  summarize(caller: AgentCaller, result: AgentsListResult): AgentsListModelResult {
    if (!("children" in result)) return result
    const omitted = result.children.filter((child) => {
      const pulls = child.openPRs
      return pulls && pulls.length > INLINE_PULLS
        && Buffer.byteLength(JSON.stringify(pulls)) > SUMMARY_BYTES + Buffer.byteLength(JSON.stringify(child.child))
        && pulls.every((pull) => Buffer.byteLength(JSON.stringify(pull)) <= PAGE_BYTES - 2)
    })
    if (!omitted.length) return result
    this.expire()
    const owner = ownerKey(caller)
    const entries = omitted.map((child) => [child.child, child.openPRs ?? []] as const)
    const serialized = JSON.stringify(entries)
    const bytes = Buffer.byteLength(serialized)
    const digest = createHash("sha256").update(serialized).digest("hex")
    let retained = [...this.snapshots].find(([, snapshot]) => snapshot.owner === owner && snapshot.digest === digest)
    if (!retained) {
      const heldBytes = [...this.snapshots.values()].reduce((sum, snapshot) => sum + snapshot.bytes, 0)
      // Never discard a valid recovery reference to make room for another summary. Keep these facts inline instead.
      if (this.snapshots.size >= SNAPSHOT_COUNT || heldBytes + bytes > SNAPSHOT_BYTES) return result
      const id = randomUUID()
      const snapshot: Snapshot = { owner, digest, bytes, expiresAt: this.now() + SNAPSHOT_MS, children: new Map(structuredClone(entries)) }
      this.snapshots.set(id, snapshot)
      retained = [id, snapshot]
    }
    const [snapshot, { expiresAt, children }] = retained
    return {
      ...result,
      children: result.children.map((child) => {
        const pulls = children.get(child.child)
        if (!pulls) return child
        const facts = { ...child }
        delete facts.openPRs
        return {
          ...facts,
          pulls: {
            open: pulls.filter((pull) => pull.state === "open").length,
            draft: pulls.filter((pull) => pull.state === "draft").length,
            reported: pulls.filter((pull) => pull.state === "reported").length,
            read: { child: child.child, view: "pulls" as const, snapshot },
            expiresAt,
          },
        }
      }),
    }
  }

  /** The ordinary per-Fin read has already checked this caller's current ownership/scope, on every page. */
  read(caller: AgentCaller, authorized: AgentsReadResult, input: AgentsReadInput): AgentsPullsReadResult | AgentRefused {
    if ("refused" in authorized) return authorized
    if (authorized.child !== input.child) return { refused: "unknown-child", why: "PR details require the exact Fin ID in the list's read object." }
    if (input.view !== "pulls" || !input.snapshot || input.report !== undefined || input.afterAsk !== undefined || input.maxChars !== undefined)
      return { refused: "conflict", why: "PR details need view pulls and the list's snapshot; report, afterAsk and maxChars do not apply." }
    const offset = input.offset ?? 0
    const limit = input.limit ?? PAGE_SIZE
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE)
      return { refused: "conflict", why: "offset must be a nonnegative integer; limit must be an integer from 1 to 20." }
    this.expire()
    const snapshot = this.snapshots.get(input.snapshot)
    if (!snapshot || snapshot.owner !== ownerKey(caller)) return { refused: "conflict", why: "This PR snapshot is unavailable to this caller, expired, or its host restarted. Its original facts cannot be recovered here. A new agents_list gives current facts; full (the default) keeps them inline." }
    const pulls = snapshot.children.get(input.child)
    if (!pulls) return { refused: "conflict", why: "This snapshot contains no omitted PR details for that Fin." }
    if (offset > pulls.length) return { refused: "conflict", why: "offset is past the end of this Fin's PR details." }
    let end = offset
    let bytes = 2
    while (end < pulls.length && end < offset + limit) {
      const next = Buffer.byteLength(JSON.stringify(pulls[end])) + (end > offset ? 1 : 0)
      if (bytes + next > PAGE_BYTES) break
      bytes += next
      end++
    }
    return {
      child: authorized.child,
      name: authorized.name,
      state: authorized.state,
      text: JSON.stringify(pulls.slice(offset, end)),
      pulls: { snapshot: input.snapshot, offset, total: pulls.length, ...(end < pulls.length && { next: end }) },
    }
  }

  private expire(): void {
    for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= this.now()) this.snapshots.delete(id)
  }
}

function ownerKey(caller: AgentCaller): string {
  switch (caller.kind) {
    case "person": return "person"
    case "agent": return JSON.stringify([caller.kind, caller.session])
    case "apex": return JSON.stringify([caller.kind, caller.device, caller.thread, caller.session])
  }
}

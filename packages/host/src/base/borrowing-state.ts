import type { BrokerState, SourceAsk } from "@mako/protocol/borrow"
import type { Steps } from "@mako/sessions/slices"

export type PersonAsk = { ask: SourceAsk; at: number }
export type BorrowingState = { state: BrokerState; waiting: PersonAsk[]; unanswered: SourceAsk[] }

/**
 * Keep live grants, grants still named by a lease/ask, and the last refusal for each identical reach. Historical
 * IDs remain in a separate append-only ledger: seeding an old secret version must never resurrect its grant.
 * The event log keeps the history. No live grant, consent, pending decision or ended-Thread mark is retired.
 */
export function* compactGrants(kept: BorrowingState): Steps<void> {
  const pinned = new Set<string>()
  for (const held of Object.values(kept.state.leases)) { pinned.add(held.lease.grant); yield }
  for (const held of Object.values(kept.state.asks)) { pinned.add(held.grant); yield }
  for (const held of Object.values(kept.state.waiting)) { pinned.add(held.grant); yield }
  const latest = new Map<string, { id: string; at: number }>()
  for (const [id, held] of Object.entries(kept.state.grants)) {
    if (held.ended) {
      const grant = held.grant
      // These are precisely the fields used by selects/reachesBorrower and the optional mode filter. Include
      // source whole rather than merging different selectors or device requirements by accident.
      const key = JSON.stringify([grant.resource, grant.scope, grant.mode, grant.source, grant.within, grant.devices])
      const known = latest.get(key)
      if (!known || held.ended.at > known.at) latest.set(key, { id, at: held.ended.at })
    }
    yield
  }
  for (const held of latest.values()) { pinned.add(held.id); yield }
  for (const [id, held] of Object.entries(kept.state.grants)) {
    if (held.ended && !pinned.has(id)) delete kept.state.grants[id]
    yield
  }
}

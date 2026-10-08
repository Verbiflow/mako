import type { ThreadEntry, ThreadPage } from "@mako/sessions"
import type { ModelOption } from "@mako/sessions/settings"
import type { ConversationControl } from "./conversation-control.js"
import type { LiveBlock } from "@mako/sessions/live-content"
import type { LiveRequest } from "./live-conversations.js"

/**
 * How the host and each window decide which conversations stay in memory.
 *
 * A conversation's transcript is durable elsewhere (the host's journal, the
 * host for a window), so letting one go costs only the read that brings it
 * back, and that read grows with its size. The rule:
 *
 * - Pinned conversations always stay: whatever is running, waiting on the
 *   person, mid-operation or on screen. Their weight still counts.
 * - The `recent` most recently used of the rest stay whatever they weigh,
 *   so going back and forth between a few is instant.
 * - The others stay, most recently used first, while the total fits in
 *   `bytes`; one that does not fit goes, and a smaller older one may still
 *   stay in the room it leaves.
 *
 * Since a reload costs about what it frees, least-recently-used by bytes is
 * also the cheapest rule to be wrong with (GreedyDual-Size with cost
 * proportional to size reduces to it). Under budget nothing goes: memory
 * nobody else needs is not worth a reload.
 */
export interface ResidencyBudget {
  bytes: number
  recent: number
}

export interface ResidencyCandidate {
  id: string
  /** When anything last read or changed it; only the order matters. */
  usedAt: number
  weight: number
  pinned: boolean
}

export interface ResidencyPlan {
  evict: string[]
  /** What stays, pinned included, by `liveContentWeight`. */
  kept: number
  pinned: number
}

export function residencyPlan(candidates: readonly ResidencyCandidate[], budget: ResidencyBudget): ResidencyPlan {
  let kept = 0
  let pinned = 0
  const loose: ResidencyCandidate[] = []
  for (const candidate of candidates) {
    if (!candidate.pinned) loose.push(candidate)
    else {
      kept += candidate.weight
      pinned += candidate.weight
    }
  }
  loose.sort((left, right) => right.usedAt - left.usedAt)
  const evict: string[] = []
  loose.forEach((candidate, index) => {
    if (index < budget.recent || kept + candidate.weight <= budget.bytes) kept += candidate.weight
    else evict.push(candidate.id)
  })
  return { evict, kept, pinned }
}

/** What a conversation holds that grows with it. */
export interface LiveContent {
  blocks: readonly LiveBlock[]
  base?: ThreadPage | null
  requests?: readonly LiveRequest[]
  control?: ConversationControl
  /** Devin's model choices alone are 113KB. */
  configOptions?: readonly ModelOption[]
}

type Measured = LiveBlock | ThreadEntry | LiveRequest | ConversationControl | readonly ModelOption[]

const measures = new WeakMap<Measured, number>()

/**
 * About how many bytes `content` keeps alive: twice its JSON length, a
 * stand-in for the strings plus the objects holding them. Blocks, entries
 * and requests are immutable and shared from one revision to the next, so
 * each is measured once; a later call walks only what changed.
 * A capture cache supplies `shared` to count immutable payload once across
 * views. `retain` commits that view's objects after deciding to keep it.
 */
export function liveContentWeight(content: LiveContent, shared?: WeakSet<object>, retain = false): number {
  let bytes = 1024 + 8 * (content.blocks.length + (content.base?.entries.length ?? 0) + (content.requests?.length ?? 0))
  const weight = (value: Measured) => {
    if (shared?.has(value)) return 0
    if (retain) shared?.add(value)
    return measured(value)
  }
  for (const block of content.blocks) bytes += weight(block)
  for (const entry of content.base?.entries ?? []) bytes += weight(entry)
  for (const request of content.requests ?? []) bytes += weight(request)
  if (content.control) bytes += weight(content.control)
  if (content.configOptions) bytes += weight(content.configOptions)
  return bytes
}

function measured(value: Measured): number {
  let bytes = measures.get(value)
  if (bytes === undefined) {
    bytes = JSON.stringify(value).length * 2
    measures.set(value, bytes)
  }
  return bytes
}

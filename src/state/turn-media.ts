import { useSyncExternalStore } from "react"
import type { MediaCheck, MediaConfirmation } from "@mako/host/contracts/turn-media"
import type { MediaCandidate } from "@mako/sessions/turn-media"
import { getMako, hasBridge } from "@/lib/bridge"

/**
 * What the host made of the files a turn's records name (`MediaCheck`),
 * asked once per tick however many turns render, and kept. The host keeps
 * its answer by call and path, so a reopened conversation is answered from
 * there, not the disk. A finished call's answer stands; a running call's
 * file may not exist yet, so its "not yet" is asked again as the call
 * moves on (its check changes when it ends) or after a few seconds.
 */
export type MediaAnswer = MediaConfirmation | undefined

const PENDING_MS = 3_000
const MAX_KEPT = 20_000
const MAX_BATCH = 200

const kept = new Map<string, { answer: MediaConfirmation; at: number }>()
const inFlight = new Set<string>()
const asking = new Map<string, MediaCheck>()
const listeners = new Map<string, Set<() => void>>()
let scheduled = false

/** The check a candidate needs, or undefined for one whose bytes the call returned. */
export function mediaCheck(candidate: MediaCandidate): MediaCheck | undefined {
  if (!candidate.path || candidate.evidence === "attached") return undefined
  const check: MediaCheck = { callId: candidate.callId, path: candidate.path, evidence: candidate.evidence }
  if (candidate.startedAt !== undefined) check.startedAt = Math.round(candidate.startedAt)
  if (candidate.endedAt !== undefined) check.endedAt = Math.round(candidate.endedAt)
  if (candidate.digest) check.digest = candidate.digest
  return check
}

const keyOf = (check: MediaCheck) => `${check.callId}\u0000${check.path}\u0000${check.endedAt ?? ""}`

function fresh(entry: { answer: MediaConfirmation; at: number } | undefined, now: number): boolean {
  return Boolean(entry) && (entry!.answer.kind !== "pending" || now - entry!.at < PENDING_MS)
}

function request(check: MediaCheck, key: string): void {
  if (inFlight.has(key)) return
  inFlight.add(key)
  asking.set(key, check)
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    const batch = [...asking.entries()]
    asking.clear()
    for (let i = 0; i < batch.length; i += MAX_BATCH) void send(batch.slice(i, i + MAX_BATCH))
  })
}

async function send(batch: [string, MediaCheck][]): Promise<void> {
  let answers: readonly MediaConfirmation[] = []
  try {
    if (hasBridge()) answers = await getMako().resolveTurnMedia(batch.map(([, check]) => check))
  } catch {
    answers = []
  }
  const at = Date.now()
  batch.forEach(([key], index) => {
    inFlight.delete(key)
    kept.delete(key)
    kept.set(key, { answer: answers[index] ?? { kind: "dropped", reason: "Mako couldn't check it" }, at })
    for (const listener of listeners.get(key) ?? []) listener()
  })
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!)
}

/**
 * Each check's answer, in order; undefined while it is first asked. The
 * same array comes back while no answer changes. With `ask` false it only
 * reads what the host already answered, asking nothing.
 */
export function useMediaAnswers(checks: readonly (MediaCheck | undefined)[], ask = true): readonly MediaAnswer[] {
  const keys = checks.map((check) => (check ? keyOf(check) : ""))
  const signature = keys.join("\u0001")
  const answers = useSyncExternalStore(
    (listener) => {
      const sets = keys.filter(Boolean).map((key) => {
        let set = listeners.get(key)
        if (!set) listeners.set(key, (set = new Set()))
        set.add(listener)
        return set
      })
      return () => sets.forEach((set) => set.delete(listener))
    },
    () => {
      const now = Date.now()
      const found: MediaAnswer[] = keys.map((key, index) => {
        if (!key) return undefined
        const entry = kept.get(key)
        if (ask && !fresh(entry, now)) request(checks[index]!, key)
        return entry?.answer
      })
      return remembered(signature, found)
    },
  )
  return answers
}

/** One array per signature and answers, so a snapshot that didn't change is the same object. */
const last = new Map<string, readonly MediaAnswer[]>()
function remembered(signature: string, answers: MediaAnswer[]): readonly MediaAnswer[] {
  const previous = last.get(signature)
  if (previous && previous.length === answers.length && previous.every((answer, index) => answer === answers[index])) return previous
  last.delete(signature)
  last.set(signature, answers)
  while (last.size > 2_000) last.delete(last.keys().next().value!)
  return answers
}

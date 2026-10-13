import { statSync } from "node:fs"
import { z } from "zod"
import type { Gap } from "@mako/protocol"
import type { JournalView } from "./queries.js"

/** How the journal stands, for `npm run attribution -- status` and the host log. */
export interface AttributionStatus {
  journal: { id: string; device: string; path: string; bytes: number }
  roots: { id: string; path: string; repository: boolean; head: string | null; files: number; changed: number; seenAt: number; caughtUpTo: string | null }[]
  entries: { total: number; unsettled: number; byCertainty: Record<string, number>; ambiguousShare: number }
  blobs: { count: number; bytes: number }
  activity: number
  footprint: number
  /** From the first event heard to the journal's commit, over recent flushes. */
  lag: LagSummary | null
  gaps: Gap[]
}

export interface LagSummary {
  flushes: number
  p50: number
  p95: number
  max: number
  /** Hashing and line maps, per flush. */
  hashMs: number
  diffMs: number
}

export const LagSummarySchema = z.object({ flushes: z.number(), p50: z.number(), p95: z.number(), max: z.number(), hashMs: z.number(), diffMs: z.number() })

export function lagSummary(flushes: readonly { lagMs: number; hashMs: number; diffMs: number; writeMs: number }[]): LagSummary | null {
  if (!flushes.length) return null
  const lags = flushes.map((flush) => flush.lagMs).sort((a, b) => a - b)
  const at = (share: number) => lags[Math.min(lags.length - 1, Math.floor(share * lags.length))]!
  const mean = (pick: (flush: (typeof flushes)[number]) => number) => Math.round((flushes.reduce((sum, flush) => sum + pick(flush), 0) / flushes.length) * 100) / 100
  return { flushes: flushes.length, p50: at(0.5), p95: at(0.95), max: lags.at(-1)!, hashMs: mean((flush) => flush.hashMs), diffMs: mean((flush) => flush.diffMs + flush.writeMs) }
}

const size = (path: string) => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function attributionStatus(view: JournalView, options: { recent?: readonly { lagMs: number; hashMs: number; diffMs: number; writeMs: number }[]; live?: boolean } = {}): AttributionStatus {
  const { store } = view
  const counts = store.counts()
  const mix = store.certaintyMix()
  const total = [...mix.values()].reduce((sum, count) => sum + count, 0)
  const stats = new Map<string, number>()
  for (const root of store.roots()) stats.set(root.id, store.stats(root.id).size)
  const files = new Map<string, number>()
  for (const file of store.files()) files.set(file.root, (files.get(file.root) ?? 0) + 1)
  const saved = store.meta("lag")
  const lag = options.recent?.length ? lagSummary(options.recent) : saved ? LagSummarySchema.parse(JSON.parse(saved)) : null
  return {
    journal: { id: store.id, device: store.device, path: store.path, bytes: size(store.path) + size(`${store.path}-wal`) },
    roots: store.roots().filter((root) => root.active).map((root) => ({
      id: root.id, path: root.path, repository: root.repository, head: root.head, files: stats.get(root.id) ?? 0, changed: files.get(root.id) ?? 0, seenAt: root.seenAt, caughtUpTo: root.mark,
    })),
    entries: { total: counts.entries, unsettled: counts.unsettled, byCertainty: Object.fromEntries(mix), ambiguousShare: total ? (mix.get("ambiguous") ?? 0) / total : 0 },
    blobs: store.blobSize(),
    activity: counts.activity,
    footprint: counts.footprint,
    lag,
    gaps: store.gaps().slice(-20),
  }
}

import { z } from "zod"
import { clientStorageScope } from "@/lib/client-storage-scope"
import { fold, recencyBoost } from "@/lib/palette-rank"

/**
 * What the palette remembers of what the person picked in it, on this device: for each row, when it was last opened
 * from the palette and how often (`opens`, its last ten times), and which queries led to it (`picks`, the last three,
 * each for 21 days). A row picked for a query is lifted the next time that query, or three letters or more of it,
 * is typed: the palette learns that "inb" means the Inbox and "dsk" the Thread about the disk. Opens make a
 * frequently used row rank first among rows that match equally well, never over a better match (`boostPoints` caps
 * it under a tier).
 *
 * Kept in localStorage, not in preferences: it's what this device's hands do, and synced it would be noise.
 */

const KEY = "mako:palette-memory:v1"
const PICK_DAYS = 21
const PICKS_PER_ROW = 3
const OPENS_PER_ROW = 10
const ROWS_KEPT = 300

const Stored = z.object({
  rows: z.record(z.string(), z.object({ opens: z.array(z.number()).max(OPENS_PER_ROW), picks: z.array(z.object({ query: z.string(), at: z.number() })).max(PICKS_PER_ROW) })),
})
type Stored = z.infer<typeof Stored>

let memory: Stored | undefined

function key(): string {
  const scope = clientStorageScope()
  return scope ? `${KEY}:${scope}` : KEY
}

function read(): Stored {
  if (memory) return memory
  try {
    const parsed = Stored.safeParse(JSON.parse(globalThis.localStorage?.getItem(key()) ?? "{}"))
    memory = parsed.success ? parsed.data : { rows: {} }
  } catch {
    memory = { rows: {} }
  }
  return memory
}

function write(next: Stored): void {
  memory = next
  try {
    globalThis.localStorage?.setItem(key(), JSON.stringify(next))
  } catch {
    // A full or refused store keeps this window's memory; the palette ranks as well without it.
  }
}

/** The person opened `id` from the palette, having typed `query`. */
export function rememberPick(id: string, query: string, now = Date.now()): void {
  const rows = { ...read().rows }
  const held = rows[id] ?? { opens: [], picks: [] }
  const folded = fold(query.trim())
  const picks = folded.length >= 2 ? [{ query: folded, at: now }, ...held.picks.filter((pick) => pick.query !== folded)].slice(0, PICKS_PER_ROW) : held.picks
  rows[id] = { opens: [now, ...held.opens].slice(0, OPENS_PER_ROW), picks }
  const ids = Object.keys(rows)
  if (ids.length > ROWS_KEPT) {
    const newest = ids.sort((a, b) => (rows[b]?.opens[0] ?? 0) - (rows[a]?.opens[0] ?? 0)).slice(ROWS_KEPT)
    for (const old of newest) delete rows[old]
  }
  write({ rows })
}

/** When `id` was last opened from the palette, if it was. */
export function lastPicked(id: string): number | undefined {
  return read().rows[id]?.opens[0]
}

/**
 * The boost the palette's memory gives `id` for `query` (folded), 0…1: how often and how lately it was opened (each
 * open counted by its age, as `recencyBoost` buckets it, at most .5), and .5 more when it was picked for this query
 * or one this query starts three letters or more of.
 */
export function memoryBoost(id: string, query: string, now = Date.now()): number {
  const row = read().rows[id]
  if (!row) return 0
  let use = 0
  for (const at of row.opens) use += recencyBoost(now - at) / 2.5
  let picked = 0
  if (query.length >= 2) {
    for (const pick of row.picks) {
      if (now - pick.at > PICK_DAYS * 86_400_000) continue
      if (pick.query === query || (query.length >= 3 && pick.query.startsWith(query))) picked = 0.5
    }
  }
  return Math.min(1, Math.min(0.5, use) + picked)
}

/** For tests: forget what was read, so the next read is from storage. */
export function resetPaletteMemory(): void {
  memory = undefined
}

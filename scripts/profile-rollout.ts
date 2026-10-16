/**
 * Where a Codex rollout's bytes and decode time go, by record kind: how many
 * lines, how many plain bytes, the largest line, and the time spent parsing
 * each kind's lines as JSON. Read-only.
 *
 *   node --import tsx scripts/profile-rollout.ts <rollout.jsonl[.zst]>
 */
import { readLineBatch } from "@mako/sessions/jsonl"

const path = process.argv[2]
if (!path) throw new Error("Name a rollout")

interface Kind { lines: number; bytes: number; largest: number; parseMs: number }
const kinds = new Map<string, Kind>()
const KIND = /^\{"timestamp":"[^"]*","type":"([a-z_]+)","payload":\{"type":"([a-z_]+)"/
const started = performance.now()
let splitMs = 0
let last = performance.now()
await readLineBatch(path, 0, (raw, place) => {
  const now = performance.now()
  splitMs += now - last
  const match = KIND.exec(raw.slice(0, 200))
  const name = match ? `${match[1]}/${match[2]}` : (/"type":"([a-z_]+)"/.exec(raw.slice(0, 200))?.[1] ?? "?")
  const kind = kinds.get(name) ?? { lines: 0, bytes: 0, largest: 0, parseMs: 0 }
  const bytes = place.to - place.from
  kind.lines++
  kind.bytes += bytes
  kind.largest = Math.max(kind.largest, bytes)
  const parsing = performance.now()
  JSON.parse(raw)
  kind.parseMs += performance.now() - parsing
  kinds.set(name, kind)
  last = performance.now()
})
const MiB = 1024 ** 2
const rows = [...kinds].sort((a, b) => b[1].bytes - a[1].bytes)
const total = rows.reduce((sum, [, kind]) => sum + kind.bytes, 0)
console.log(`${(total / MiB).toFixed(0)} MiB plain in ${Math.round(performance.now() - started)} ms; reading and splitting ${Math.round(splitMs)} ms`)
for (const [name, kind] of rows.slice(0, 16))
  console.log(`${name.padEnd(44)} ${String(kind.lines).padStart(7)} lines ${(kind.bytes / MiB).toFixed(1).padStart(9)} MiB  largest ${(kind.largest / MiB).toFixed(2).padStart(8)} MiB  parse ${Math.round(kind.parseMs).toString().padStart(6)} ms`)

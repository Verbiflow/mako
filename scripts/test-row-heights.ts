import assert from "node:assert/strict"
import { PRIOR_PX_PER_CHAR, RowHeights, estimateRow, learnedPxPerChar, sameFacts, type KeptRow } from "../src/lib/row-heights"

/**
 * A transcript's row sizes kept per conversation, across a reload, within bounds; and the estimate for rows never
 * measured, learned from those that were.
 */

const row = (chars: number, pxPerChar: number, tools = 0, lines = 0): KeptRow =>
  ({ chars, lines, tools, size: Math.round(estimateRow({ chars, lines, tools }, pxPerChar)) })

// The estimate follows what a row holds, and is learned from what rows measured.
{
  assert.equal(learnedPxPerChar([row(500, 0.6)]), PRIOR_PX_PER_CHAR, "Too little prose says nothing yet")
  const measured = [row(3000, 0.45, 2, 12), row(5000, 0.45, 9, 40), row(800, 0.45)]
  const learned = learnedPxPerChar(measured)
  assert.ok(Math.abs(learned - 0.45) < 0.01, `The ratio is the one the rows were laid out at (${learned})`)
  const unseen = { chars: 4000, lines: 20, tools: 3 }
  const real = row(4000, 0.45, 3, 20).size
  assert.ok(Math.abs(estimateRow(unseen, learned) - real) < Math.abs(360 - real) / 10, "An unseen row's estimate is far nearer than a constant")
  assert.ok(!Number.isInteger(estimateRow(unseen, learned)), "An estimate is never a measurement's whole number")
  assert.ok(estimateRow({ chars: 0, lines: 0, tools: 40 }, learned) > estimateRow({ chars: 0, lines: 0, tools: 2 }, learned), "Tool rows count")
  assert.ok(sameFacts(unseen, { ...unseen }) && !sameFacts(unseen, { ...unseen, chars: 4001 }))
}

// Kept per conversation at a width, across a reload, the oldest conversations and rows let go first.
{
  const stored = new Map<string, string>()
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) }
  const heights = new RowHeights(storage, { conversations: 3, rows: 4, bytes: 100_000 })
  const rows = new Map(Array.from({ length: 6 }, (_, index) => [`turn-${index}`, row(2000 + index, 0.4)] as const))
  heights.keep("live:a", 1440, rows)
  assert.equal(heights.kept("live:a", 1440)?.size, 4, "Only a conversation's newest rows are kept")
  assert.ok(heights.kept("live:a", 1440)?.has("turn-5") && !heights.kept("live:a", 1440)?.has("turn-0"))
  assert.equal(heights.kept("live:a", 1200), undefined, "At another width nothing kept stands")
  for (const source of ["live:b", "live:c", "live:d"]) heights.keep(source, 1440, rows)
  assert.equal(heights.kept("live:a", 1440), undefined, "The conversation kept longest ago goes")
  heights.save()
  const reloaded = new RowHeights(storage, { conversations: 3, rows: 4, bytes: 100_000 })
  assert.deepEqual(reloaded.kept("live:d", 1440)?.get("turn-5"), rows.get("turn-5"), "A reload finds a row at the size it measured")
  assert.ok(Math.abs(reloaded.pxPerChar(1440) - 0.4) < 0.01, "and the ratio the window had learned")
  assert.equal(reloaded.pxPerChar(900), PRIOR_PX_PER_CHAR, "A width nothing was measured at starts from the prior")
  const small = new RowHeights(storage, { conversations: 3, rows: 4, bytes: 400 })
  small.save()
  assert.ok((stored.get("mako:transcript-row-heights")?.length ?? 0) <= 400, "What's written stays within its bytes")
  assert.ok(new RowHeights(storage).kept("live:d", 1440), "the newest conversation still in it")
  stored.set("mako:transcript-row-heights", "{not json")
  assert.equal(new RowHeights(storage).kept("live:d", 1440), undefined, "Unreadable storage is as if nothing was kept")
}

console.log("row heights: sizes kept per conversation and width across a reload within bounds, and an estimate learned from measured rows")

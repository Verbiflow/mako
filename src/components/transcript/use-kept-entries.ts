import { useState } from "react"
import { keptEntries, sameSerialized } from "@/lib/kept-entries"

/**
 * `entries` as the transcript's rows are given them: each value the same object for as long as it says the same
 * (`keptEntries`), and the map itself for as long as all of them do. For a map that's made again only now and then
 * (from the requests): each new one is compared once, and costs the caller one more render.
 */
export function useKeptEntries<Key, Value>(
  entries: ReadonlyMap<Key, Value>,
  same: (left: Value, right: Value) => boolean = sameSerialized
): ReadonlyMap<Key, Value> {
  const [held, hold] = useState({ source: entries, kept: entries })
  if (held.source === entries) return held.kept
  // Adjusted while rendering, as a value derived from what was last given: an effect would draw the rows once with the
  // new objects first.
  const kept = keptEntries(held.kept, entries, same)
  hold({ source: entries, kept })
  return kept
}

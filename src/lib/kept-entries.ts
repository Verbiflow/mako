/**
 * `next` with every value `previous` held under the same key saying the same as `previous` has it, and `previous`
 * itself when nothing differs. A map made again from the requests or the turns hands a row a new object for a value
 * that hasn't changed; a row memoized on what it's given then draws again for nothing.
 */
export function keptEntries<Key, Value>(
  previous: ReadonlyMap<Key, Value>,
  next: ReadonlyMap<Key, Value>,
  same: (left: Value, right: Value) => boolean = sameSerialized
): ReadonlyMap<Key, Value> {
  if (previous === next) return previous
  let changed = previous.size !== next.size
  const kept = new Map<Key, Value>()
  for (const [key, value] of next) {
    const held = previous.get(key)
    // A key held as undefined and a key not held read alike here; `has` tells them apart.
    if (held !== undefined || previous.has(key)) {
      // SAFETY: `has` said the key is held, so what `get` returned is its value, undefined included.
      const before = held as Value
      if (before === value || same(before, value)) {
        kept.set(key, before)
        continue
      }
    }
    changed = true
    kept.set(key, value)
  }
  return changed ? kept : previous
}

/** The same value as its JSON says it: for the small plain values a request or a turn is summed up as. */
export function sameSerialized<Value>(left: Value, right: Value): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

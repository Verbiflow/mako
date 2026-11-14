import assert from "node:assert/strict"
import { test } from "node:test"
import type { StatRow } from "@mako/host/attribution/journal-store"
import { StatCache } from "@mako/host/attribution/stat-cache"

/*
 * The tracker's stat cache packs its rows in columns (`StatCache`) and must answer as the `Map` of row objects it
 * replaced: the same rows, the same order (a deleted path set again goes last), through any mix of changes.
 */

const row = (index: number): StatRow => ({
  dev: 16_777_234 + (index % 3),
  ino: 2 ** 40 + index,
  size: index * 7,
  mode: index % 2 ? 0o100755 : 0o100644,
  mtimeNs: 1_794_447_951_947_000_000n + BigInt(index),
  ctimeNs: 1_794_447_951_947_000_001n + BigInt(index),
  ref: index % 5 ? null : `sha256-${index.toString(16).padStart(64, "0")}`,
  checkedNs: 1_794_447_951_948_000_000n + BigInt(index * 3),
})

test("the packed stat cache answers as a Map of its rows through any mix of changes", () => {
  const cache = new StatCache()
  const map = new Map<string, StatRow>()
  // A fixed pseudo-random walk: the same every run.
  let seed = 7
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31)
  for (let step = 0; step < 50_000; step++) {
    const path = `src/d${next() % 40}/f${next() % 2_000}.ts`
    if (next() % 4 === 0) assert.equal(cache.delete(path), map.delete(path))
    else {
      const value = row(next() % 100_000)
      cache.set(path, value)
      map.set(path, value)
    }
    if (step % 5_000 === 0) assert.deepEqual([...cache], [...map])
  }
  assert.equal(cache.size, map.size)
  assert.deepEqual([...cache.keys()], [...map.keys()])
  assert.deepEqual([...cache.values()], [...map.values()])
  for (const [path, value] of map) {
    assert.ok(cache.has(path))
    assert.deepEqual(cache.get(path), value)
  }
  assert.equal(cache.get("nowhere"), undefined)
  assert.equal(cache.has("nowhere"), false)
})

test("a row the cache returned stays as it was when the cache changes", () => {
  const cache = new StatCache([["a", row(1)]])
  const held = cache.get("a")!
  cache.set("a", row(2))
  cache.delete("a")
  cache.set("b", row(3))
  assert.deepEqual(held, row(1))
})

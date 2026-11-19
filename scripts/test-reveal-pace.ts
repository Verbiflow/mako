import assert from "node:assert/strict"
import { REVEAL_DRAIN_MS, REVEAL_MAX_MS, REVEAL_MIN_MS, RevealPace } from "../src/lib/reveal-pace"

/**
 * A streaming answer's reveal: each lump of text is spread over about the gap its lumps come at, never more than
 * `REVEAL_MAX_MS` behind what the page holds, and what's left when the stream ends is shown within `REVEAL_DRAIN_MS`.
 */

// Lumps a frame apart are each shown by the time the next lands, a little at every step.
{
  const pace = new RevealPace()
  pace.showAll(100, 0)
  assert.equal(pace.step(10), 100, "What was there when the stream was first seen is shown")
  let at = 0
  let length = 100
  const seen: number[] = []
  for (let lump = 0; lump < 20; lump++) {
    at += 50
    length += 40
    pace.arrived(length, at)
    for (let frame = 1; frame <= 3; frame++) seen.push(pace.step(at + frame * 16))
    assert.ok(length - pace.step(at + 50) <= 1, `Lump ${lump} is shown by the time the next lands`)
  }
  assert.ok(seen.every((shown, index) => index === 0 || shown >= seen[index - 1]!), "The reveal never goes back")
  assert.ok(new Set(seen).size > seen.length / 2, "It moves at every frame, not a lump at a time")
}

// However far apart the lumps come, one is fully shown within the bound.
{
  const pace = new RevealPace()
  pace.showAll(0, 0)
  for (const [at, length] of [[0, 300], [2000, 900], [9000, 1500]] as const) {
    pace.arrived(length, at)
    assert.ok(pace.step(at + REVEAL_MIN_MS / 2) < length, "A lump isn't shown all at once")
    assert.equal(pace.step(at + REVEAL_MAX_MS), length, `A lump is shown within ${REVEAL_MAX_MS} ms of landing`)
    assert.ok(pace.caughtUp)
  }
}

// The stream ending shows what's left within the drain; text rewritten shorter hides nothing.
{
  const pace = new RevealPace()
  pace.showAll(0, 0)
  pace.arrived(400, 0)
  pace.arrived(800, 400)
  pace.drain(410)
  assert.equal(pace.step(410 + REVEAL_DRAIN_MS), 800, `What's left is shown within ${REVEAL_DRAIN_MS} ms of the end`)
  pace.arrived(790, 600)
  assert.equal(pace.step(601), 790, "A shorter text is all shown")
  pace.showAll(1200, 700)
  assert.equal(pace.step(700), 1200, "A hidden tab or reduced motion shows everything at once")
}

console.log(`reveal pace: lumps spread over their gap, each shown within ${REVEAL_MAX_MS} ms, the rest within ${REVEAL_DRAIN_MS} ms of the end`)

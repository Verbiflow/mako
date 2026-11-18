import assert from "node:assert/strict"
import type { Exchange } from "../src/lib/exchanges"
import type { StreamClock } from "../src/lib/stream-frames"
import { ExchangePacer, STREAM_PACE_MS, answerGrew, answerPaceMs } from "../src/lib/stream-pace"

// A turn whose answer reads `text`, the turns before it kept as they are.
const prompt = { id: "p", role: "user" as const, blocks: [{ type: "text" as const, text: "Explain it" }] }
const earlier: Exchange = { id: "e0", prompt, response: [], system: [] }
const turn = (text: string, extra?: Partial<Exchange>): Exchange => ({
  id: "e1", prompt, system: [], ...extra,
  response: [{ id: "a1", role: "assistant", blocks: [{ type: "text", text }] }],
})
type Turns = { exchanges: Exchange[] }
const turns = (text: string, extra?: Partial<Exchange>): Turns => ({ exchanges: [earlier, turn(text, extra)] })

// What grew, and what didn't.
{
  const before = turns("Hello")
  assert.deepEqual(answerGrew(before.exchanges, turns("Hello there").exchanges), { drawn: "Hello", now: "Hello there" })
  assert.equal(answerGrew(before.exchanges, turns("Help").exchanges), undefined, "a rewrite isn't growth")
  assert.equal(answerGrew(before.exchanges, { exchanges: [{ ...earlier }, turn("Hello there")] }.exchanges), undefined, "an earlier turn changed")
  const tool = { exchanges: [earlier, { ...turn("Hello"), response: [...turn("Hello").response, { id: "t1", role: "tool" as const, blocks: [] }] }] }
  assert.equal(answerGrew(before.exchanges, tool.exchanges), undefined, "a tool call isn't growth")
}

// The pace: the first words at once, then the turn every second while only its answer grows, short or long. The words
// themselves don't wait for it: the prose reads them from the conversation (`useStreamedText`).
{
  assert.equal(answerPaceMs(""), 0)
  assert.equal(answerPaceMs("  \n"), 0, "nothing but space is nothing drawn yet")
  assert.equal(answerPaceMs("Hi"), STREAM_PACE_MS)
  assert.equal(answerPaceMs("word ".repeat(600)), STREAM_PACE_MS)
}

// The pacer, on a clock the test turns.
{
  let now = 0
  const timers: Array<{ at: number; run: () => void; live: boolean }> = []
  const clock: StreamClock = {
    now: () => now,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, live: true }
      timers.push(timer)
      return () => void (timer.live = false)
    },
  }
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const next = timers.filter((timer) => timer.live && timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      now = next.at
      next.live = false
      next.run()
    }
    now = until
  }
  let store: Turns = turns("")
  const pacer = new ExchangePacer<Turns>(clock)
  const draws: Array<{ at: number; text: string }> = []
  const shownText = () => {
    const block = pacer.shown(store)!.exchanges.at(-1)!.response[0]!.blocks[0]!
    assert.equal(block.type, "text")
    return block.type === "text" ? block.text : ""
  }
  const draw = () => draws.push({ at: now, text: shownText() })
  const write = (text: string) => {
    store = turns(text)
    pacer.take(store, draw)
  }
  draw()
  // The first words draw at once.
  advance(50)
  write("Hello")
  assert.equal(draws.at(-1)!.text, "Hello")
  // After them the turn waits its pace, however short the answer, and then draws the latest.
  advance(20)
  write("Hello the")
  write("Hello there")
  assert.equal(draws.at(-1)!.text, "Hello", "held until the pace allows")
  assert.equal(pacer.shown(store)!.exchanges.at(-1)!.response[0]!.blocks[0]!.type, "text")
  advance(STREAM_PACE_MS - 20)
  assert.equal(draws.at(-1)!.text, "Hello there")
  // A long answer the same: every second while it grows, a paragraph's end included.
  const long = "word ".repeat(300)
  advance(100)
  write(long)
  const from = draws.length
  for (let at = 0; at < 3_200; at += 50) {
    advance(50)
    write(`${long}${"x".repeat(at / 50 + 1)}${at === 1_600 ? " end.\n\nNext" : ""}`)
  }
  const gaps = draws.slice(from).map((each, index, all) => (index ? each.at - all[index - 1]!.at : 0)).slice(1)
  assert.ok(gaps.length >= 2 && gaps.every((gap) => gap >= STREAM_PACE_MS - 1), `the turn drew every second (${gaps})`)
  advance(STREAM_PACE_MS)
  // A change that isn't growth draws at once, with what was held.
  advance(10)
  write(`${long}${"x".repeat(30)} end.\n\nNext words`)
  const held = draws.length
  const grown = turns(`${long}${"x".repeat(30)} end.\n\nNext words`)
  store = { exchanges: [earlier, { ...grown.exchanges[1]!, response: [...grown.exchanges[1]!.response, { id: "t1", role: "tool" as const, blocks: [] }] }] }
  pacer.take(store, draw)
  assert.equal(draws.length, held + 1, "drawn at once")
  assert.ok(draws.at(-1)!.text.endsWith("Next words"))
  pacer.stop()
}

console.log("stream pace: an answer's first words draw at once, its turn then every second while only the answer grows, and anything else at once with what was held")

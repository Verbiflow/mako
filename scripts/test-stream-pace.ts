import assert from "node:assert/strict"
import type { Exchange } from "../src/lib/exchanges"
import type { StreamClock } from "../src/lib/stream-frames"
import { ExchangePacer, STREAM_PACE_LONG_MS, STREAM_PACE_SHORT_CHARS, answerGrew, answerPaceMs } from "../src/lib/stream-pace"

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

// The pace: the first words at once, a short answer each frame, a long one each paragraph or 400 ms.
{
  assert.equal(answerPaceMs("", "Hi"), 0)
  assert.equal(answerPaceMs("Hi", "Hi there"), 50)
  const long = "word ".repeat(STREAM_PACE_SHORT_CHARS / 5)
  assert.equal(answerPaceMs(long, `${long}more`), STREAM_PACE_LONG_MS)
  assert.equal(answerPaceMs(long, `${long}end.\n\nNext`), 50, "a paragraph that ended draws on the next frame")
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
  // Short: each frame, the latest text.
  advance(20)
  write("Hello the")
  write("Hello there")
  assert.equal(draws.at(-1)!.text, "Hello", "held until the frame")
  assert.equal(pacer.shown(store)!.exchanges.at(-1)!.response[0]!.blocks[0]!.type, "text")
  advance(30)
  assert.equal(draws.at(-1)!.text, "Hello there")
  // Long: every 400 ms while a paragraph grows.
  const long = "word ".repeat(STREAM_PACE_SHORT_CHARS / 5)
  advance(100)
  write(long)
  const from = draws.length
  for (let at = 0; at < 1_200; at += 50) {
    advance(50)
    write(`${long}${"x".repeat(at / 50 + 1)}`)
  }
  const gaps = draws.slice(from).map((each, index, all) => (index ? each.at - all[index - 1]!.at : 0)).slice(1)
  assert.ok(gaps.length >= 2 && gaps.every((gap) => gap >= STREAM_PACE_LONG_MS - 1), `long answer drew every 400 ms (${gaps})`)
  // A paragraph ends: drawn on the next frame, not at the 400 ms mark.
  const before = draws.length
  advance(60)
  write(`${long}${"x".repeat(30)} end.\n\nNext`)
  advance(60)
  assert.equal(draws.length, before + 1)
  assert.ok(draws.at(-1)!.text.endsWith("Next"))
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

console.log("stream pace: an answer's first words draw at once, a short answer each frame, a long one each paragraph or every 400 ms, and anything else at once with what was held")

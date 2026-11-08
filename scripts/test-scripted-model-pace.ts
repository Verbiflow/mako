/**
 * The stand-in model's `pace`: each delta waits before it is written, and `sent` hears every write. A delayed HTTP
 * reader can receive several writes together. Unpaced, a reply is written at once.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { ranOut } from "./lib/ran-out.ts"
import { scriptedModel } from "./scripted-model.ts"

const REPLY = "one two three four five six"
const Delta = z.object({ type: z.literal("response.output_text.delta"), delta: z.string() })

/** The reply's text, event order and each delta's arrival time, over HTTP. */
async function deltasOverHttp(url: string, readAfter?: Promise<void>): Promise<{ arrived: number[]; text: string; events: string[] }> {
  const started = performance.now()
  const response = await fetch(`${url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", stream: true, input: "go", tools: [{ type: "function", name: "noop" }] }) })
  await readAfter
  const arrived: number[] = []
  const events: string[] = []
  let text = ""
  const decoder = new TextDecoder()
  let held = ""
  for await (const chunk of response.body!) {
    held += decoder.decode(chunk, { stream: true })
    for (let end = held.indexOf("\n\n"); end >= 0; end = held.indexOf("\n\n")) {
      const data = /^data: (.*)$/m.exec(held.slice(0, end))?.[1]
      held = held.slice(end + 2)
      if (!data) continue
      const event: unknown = JSON.parse(data)
      events.push(z.object({ type: z.string() }).parse(event).type)
      const delta = Delta.safeParse(event).data
      if (delta) {
        arrived.push(performance.now() - started)
        text += delta.delta
      }
    }
  }
  return { arrived, text, events }
}

for (const buffered of [false, true]) test(`a paced reply waits before each write, with an HTTP reader ${buffered ? "held until completion" : "reading as it streams"}`, async () => {
  const sent: string[] = []
  const waits: number[] = []
  const waitsAtDelta: number[][] = []
  const written: number[] = []
  const complete = Promise.withResolvers<void>()
  const model = await scriptedModel({ pace: 40, reply: () => ({ text: REPLY }), sent: (event) => {
    const type = z.object({ type: z.string() }).parse(event).type
    sent.push(type)
    if (Delta.safeParse(event).success) {
      waitsAtDelta.push(waits.filter((ms) => ms === 40))
      written.push(performance.now())
    }
    if (type === "response.completed") complete.resolve()
  } })
  try {
    const { result: { arrived, text, events } } = await ranOut(() => deltasOverHttp(model.url, buffered ? complete.promise : undefined), waits)
    assert.equal(arrived.length, 6)
    assert.equal(text, REPLY, "HTTP delivers every delta's text in order")
    const gaps = written.slice(1).map((at, index) => at - written[index]!)
    assert.ok(gaps.every((gap) => gap >= 30), `deltas were written ${gaps.map(Math.round).join(", ")} ms apart`)
    assert.deepEqual(waitsAtDelta, Array.from({ length: 6 }, (_, index) => Array<number>(index + 1).fill(40)), "each delta is written after its own 40 ms wait, not after waits collected before the reply")
    assert.deepEqual(sent, events, "each write is reported in wire order")
    assert.equal(sent.at(-1), "response.completed", "the last event told is the last one written")
  } finally {
    await model.close()
  }
})

test("unpaced, a reply is written at once", async () => {
  const model = await scriptedModel({ reply: () => ({ text: REPLY }) })
  try {
    const { result: { arrived, text }, waits } = await ranOut(() => deltasOverHttp(model.url))
    assert.equal(arrived.length, 6)
    assert.equal(text, REPLY)
    // At once, by what was waited for rather than the runner's clock: a paced delta waits its pace first.
    assert.deepEqual(waits, [], `the deltas took ${Math.round(arrived.at(-1)! - arrived[0]!)} ms, with no wait before any`)
  } finally {
    await model.close()
  }
})

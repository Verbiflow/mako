/**
 * The stand-in model's `pace`: a streamed reply's deltas arrive that far apart, and `sent` hears every event as it is
 * written. Unpaced, a reply is written at once.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { scriptedModel } from "./scripted-model.ts"

const REPLY = "one two three four five six"
const Delta = z.object({ type: z.literal("response.output_text.delta"), delta: z.string() })

/** When each text delta of a streamed Responses request reached the caller, over HTTP. */
async function deltasOverHttp(url: string): Promise<number[]> {
  const started = performance.now()
  const response = await fetch(`${url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", stream: true, input: "go", tools: [{ type: "function", name: "noop" }] }) })
  const arrived: number[] = []
  const decoder = new TextDecoder()
  let held = ""
  for await (const chunk of response.body!) {
    held += decoder.decode(chunk, { stream: true })
    for (let end = held.indexOf("\n\n"); end >= 0; end = held.indexOf("\n\n")) {
      const data = /^data: (.*)$/m.exec(held.slice(0, end))?.[1]
      held = held.slice(end + 2)
      if (data && Delta.safeParse(JSON.parse(data)).success) arrived.push(performance.now() - started)
    }
  }
  return arrived
}

test("a paced reply's deltas arrive that far apart, and each event is told as it's written", async () => {
  const sent: string[] = []
  const model = await scriptedModel({ pace: 40, reply: () => ({ text: REPLY }), sent: (event) => void sent.push(z.object({ type: z.string() }).parse(event).type) })
  try {
    const arrived = await deltasOverHttp(model.url)
    assert.equal(arrived.length, 6)
    const gaps = arrived.slice(1).map((at, index) => at - arrived[index]!)
    assert.ok(gaps.every((gap) => gap >= 30), `deltas came ${gaps.map(Math.round).join(", ")} ms apart`)
    assert.equal(sent.filter((type) => type === "response.output_text.delta").length, 6)
    assert.equal(sent.at(-1), "response.completed", "the last event told is the last one written")
  } finally {
    await model.close()
  }
})

test("unpaced, a reply is written at once", async () => {
  const model = await scriptedModel({ reply: () => ({ text: REPLY }) })
  try {
    const arrived = await deltasOverHttp(model.url)
    assert.equal(arrived.length, 6)
    assert.ok(arrived.at(-1)! - arrived[0]! < 30, `the deltas took ${Math.round(arrived.at(-1)! - arrived[0]!)} ms`)
  } finally {
    await model.close()
  }
})

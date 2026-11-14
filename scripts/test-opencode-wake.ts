import assert from "node:assert/strict"
import { join } from "node:path"
import type { OpenCodeEvent } from "@opencode/client"
import { OpenCodeDecoder, type OpenCodeTurnFact } from "@mako/host/harnesses/opencode/decoder"
import { FIXTURE_ROOT, readRecording } from "./native-decoding.ts"

// An inbox item OpenCode delivers between two turns of one run opens a turn of its own (2.2.7 runs a woken turn in
// the execution of the turn before it); one delivered after a step that handed tool results on (`tool-calls`) joins
// the turn still running, as the person's steer does. Read from the recorded captures, through the decoder.

/** Each inbox delivery the decoder reads from a pair's capture, and whether it came between turns. */
async function deliveries(pair: string): Promise<{ inbox: string; between: boolean }[]> {
  const recording = await readRecording(join(FIXTURE_ROOT, "opencode", "pairs", pair, "capture.jsonl"))
  // SAFETY: a capture's messages are the OpenCode events its driver received.
  const events = recording.messages as OpenCodeEvent[]
  const root = events.find((event) => event.type === "session.inbox.enqueued")?.data.sessionID
  assert.ok(root, `${pair} enqueues something on its root`)
  const decoder = new OpenCodeDecoder(root, "/tmp/mako-pair/project", { launchAccess: "ask", contextSize: () => undefined })
  const found: { inbox: string; between: boolean }[] = []
  for (const event of events)
    for (const decoded of decoder.decode(event)) {
      if (decoded.kind !== "effect" || decoded.effect.type !== "turn") continue
      const fact: OpenCodeTurnFact = decoded.effect.turn
      if (fact.type === "delivered") found.push({ inbox: fact.inbox, between: fact.between === true })
    }
  return found
}

const steered = await deliveries("steered-shell")
assert.equal(steered.length, 2, "the prompt and the steer")
assert.equal(steered[1]!.between, false, "a steer delivered after a step that ended on tool calls joins the turn still running")

const woken = await deliveries("subagent-wake")
assert.equal(woken.at(-1)!.between, true, "a subagent's report delivered after the turn's last step ended opens its own")
console.log("PASS: an OpenCode inbox item opens a turn of its own only between turns, never after a step that handed tool results on")

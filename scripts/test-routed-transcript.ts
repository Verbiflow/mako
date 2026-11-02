import assert from "node:assert/strict"
import { identifyTool } from "@mako/sessions/tool-identity"
import type { Entry } from "@mako/sessions/entries"
import { entriesToMessages } from "../src/lib/entry-messages.ts"
import { responseSections } from "../src/lib/exchanges.ts"
import { stillDrawn, turnFolds } from "../src/lib/turn-fold.ts"
import type { Block, ChatMessage } from "../src/lib/types.ts"

/**
 * A lead's `agents_send` in its transcript (`npm run test:orch-front-door`):
 * one routing line where the call returned, read from the call and its
 * answer, the same for a live turn and a saved one on every harness's name
 * for Mako's tool, from blocks and from the entries a harness records; never
 * for a refusal or a call still running; and kept in view when the turn folds
 * its work.
 */
const NAMES = {
  claude: "mcp__mako__agents_send",
  codex: "mako.agents_send",
  cursor: "mako-agents_send",
  grok: "mako__agents_send",
  devin: "mako.agents_send",
} satisfies Record<string, string>
const ANSWER = JSON.stringify({ child: "thread-android", name: "android", request: "req-1", delivery: "queued" }, null, 2)

function turn([harness, name]: [string, string], id: string, result: Partial<Extract<Block, { type: "toolResult" }>> = {}): ChatMessage[] {
  const args = { to: "child:android", forward: true, clientKey: "k" }
  const tool = identifyTool({ harness, name, args })
  return [{
    id: `${id}-message`,
    role: "assistant",
    provider: harness,
    timestamp: 1_000,
    blocks: [
      { type: "toolCall", id, name: tool.name, tool, arguments: args },
      { type: "toolResult", id, name: tool.name, text: ANSWER, ...result },
      { type: "text", text: "Passed to android." },
    ],
  }]
}

for (const named of Object.entries(NAMES)) {
  const [harness] = named
  for (const id of ["4:call-1", "msg-7-tool-call-1"]) {
    const sections = responseSections(turn(named, id))
    const routed = sections.filter((section) => section.kind === "routed")
    assert.equal(routed.length, 1, `${harness} ${id}: one routing line`)
    const [line] = routed
    assert.ok(line?.kind === "routed")
    assert.deepEqual(line.routed, { to: "android", forward: true })
    assert.deepEqual(line.landed, { child: "thread-android", request: "req-1", delivery: "queued" })
    assert.deepEqual(sections.map((section) => section.kind), ["work", "routed", "prose"], "the call's row stays in the work, the line follows it")
    assert.ok(stillDrawn(line))
    const folds = turnFolds(sections, 0)
    const over = folds.filter((fold) => fold.start <= 1 && 1 < fold.end)
    assert.ok(over.every((fold) => fold.kept.includes(1)), "a fold over the line keeps it in view")
  }
  const refused = responseSections(turn(named, "1:c", { text: `refused: conflict\n${JSON.stringify({ refused: "conflict", why: "stopped" })}` }))
  assert.equal(refused.filter((section) => section.kind === "routed").length, 0, `${harness}: a refusal is no routing`)
  const running = responseSections(turn(named, "1:c", { text: "", streaming: true }))
  assert.equal(running.filter((section) => section.kind === "routed").length, 0, `${harness}: nothing until it returns`)
  const failed = responseSections(turn(named, "1:c", { isError: true }))
  assert.equal(failed.filter((section) => section.kind === "routed").length, 0, `${harness}: a failed call routed nothing`)
  const partial = responseSections(turn(named, "1:c", { text: "{\"child\": \"thread-andr" }))
  const kept = partial.find((section) => section.kind === "routed")
  assert.ok(kept?.kind === "routed" && kept.landed === undefined, `${harness}: a result kept in part still names where it went`)
}

for (const [harness, name] of Object.entries(NAMES)) {
  const entries: Entry[] = [
    { type: "tool", id: "call-1", name, title: name, toolKind: "other", input: JSON.stringify({ to: "android", forward: true, clientKey: "k" }), output: ANSWER, status: "completed" },
    { type: "text", text: "Passed to android." },
  ]
  for (const source of [{ kind: "saved", provider: harness }, { kind: "live", running: false, provider: harness }] as const) {
    const routed = responseSections(entriesToMessages(entries, source).messages).filter((section) => section.kind === "routed")
    assert.equal(routed.length, 1, `${harness} ${source.kind}: the recorded call draws its routing line`)
    assert.ok(routed[0]?.kind === "routed")
    assert.deepEqual(routed[0].routed, { to: "android", forward: true }, `${harness} ${source.kind}: arguments kept as the harness's JSON`)
    assert.equal(routed[0].landed?.delivery, "queued")
  }
}

console.log("routed transcript ok")

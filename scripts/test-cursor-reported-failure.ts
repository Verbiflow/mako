import assert from "node:assert/strict"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { AcpPromptTurn, type AcpTurnResult } from "../electron/acp-prompt-turn.ts"
import { observeTurnUpdate, turnVerdict } from "../electron/acp-turn-verdict.ts"
import { cursorReportedFailure } from "../electron/providers/cursor/reported-failure.ts"
import { cursorAcpSource } from "../electron/providers/cursor/acp.ts"
import { CONNECTION_LOST_STOP } from "../electron/contracts/providers-acp.ts"
import { classifyProviderFailure } from "../electron/contracts/provider-failure.ts"

const CANCEL = "Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)"

/*
 * The block sequence cursor-agent 2026.09.10 streamed for the turn that ended
 * on the dropped stream, as recorded in the conversation journal: a text
 * chunk, two edit tool calls (each with its completing update), the error as
 * the final text chunk, then `end_turn`.
 */
const SESSION = "af97345e-6644-4136-b1fd-ae0168fb558b"
function chunk(text: string): SessionNotification {
  return { sessionId: SESSION, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }
}
function toolCall(id: string): SessionNotification {
  return {
    sessionId: SESSION,
    update: { sessionUpdate: "tool_call", toolCallId: id, title: "Edit `electron/live-conversations.ts`", kind: "edit", status: "pending" },
  }
}
function toolDone(id: string): SessionNotification {
  return { sessionId: SESSION, update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" } }
}
const DROPPED_TURN: SessionNotification[] = [
  chunk("Now `stop()` and `load()`:"),
  toolCall("toolu_019fQBSiuicVkCsTjpSZqaHb"),
  toolDone("toolu_019fQBSiuicVkCsTjpSZqaHb"),
  toolCall("toolu_01HkdnAjUkFpb8eovpahKrZk"),
  toolDone("toolu_01HkdnAjUkFpb8eovpahKrZk"),
  chunk("\n\nError: RetriableError: [canceled] http/2 stream"),
  chunk(" closed with error code CANCEL (0x8)"),
]

async function replay(notifications: SessionNotification[], stopReason: "end_turn" | "cancelled" = "end_turn") {
  const results: AcpTurnResult[] = []
  const turn = new AcpPromptTurn((result) => results.push(result))
  const sending = turn.send(async () => {
    for (const notification of notifications) observeTurnUpdate(turn, notification)
    return { stopReason }
  })
  await sending
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(results.length, 1)
  return { turn, result: results[0]! }
}

// The detector itself: Cursor's wire syntax, anchored to the end of the text.
assert.equal(cursorReportedFailure(`\n\n${CANCEL}`), CANCEL.slice("Error: ".length))
assert.equal(cursorReportedFailure("Done.\n\nError: RetriableError: [unavailable] Error"), "RetriableError: [unavailable] Error")
assert.equal(
  cursorReportedFailure("\n\nError: NonRetriableError: [invalid_argument] conversation too long"),
  "NonRetriableError: [invalid_argument] conversation too long"
)
assert.equal(
  cursorReportedFailure("\n\nError: [unauthenticated] Backend rejected authentication. Verify this is a User API Key."),
  "[unauthenticated] Backend rejected authentication. Verify this is a User API Key."
)
assert.equal(cursorReportedFailure(`The log said \`${CANCEL}\` and then recovered.`), undefined, "a quoted error mid-answer is an answer")
assert.equal(cursorReportedFailure(`${CANCEL}\n\nI retried and it worked.`), undefined, "text after the error means the agent went on")
assert.equal(cursorReportedFailure("Error: something my own script printed"), undefined, "only cursor-agent's own error classes count")
assert.equal(cursorReportedFailure(""), undefined)
assert.equal(cursorAcpSource.reportedFailure, cursorReportedFailure, "the Cursor source owns the detection")

// The real sequence: end_turn plus the final error chunk is a lost connection.
{
  const { turn, result } = await replay(DROPPED_TURN)
  assert.deepEqual(result, { kind: "completed", stopReason: "end_turn" })
  assert.equal(turn.finalText, `\n\n${CANCEL}`, "tool calls reset the final text; the split error chunks re-join")
  const verdict = turnVerdict(result, turn.finalText, cursorAcpSource.reportedFailure)
  assert.deepEqual(verdict, {
    status: "failed",
    lastStop: CONNECTION_LOST_STOP,
    error: "RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
  })
  assert.equal(classifyProviderFailure(verdict.error).kind, "network")
}

// The same sequence without the trailing error is an ordinary completed turn.
{
  const { turn, result } = await replay(DROPPED_TURN.slice(0, -2))
  assert.equal(turn.finalText, "")
  assert.deepEqual(turnVerdict(result, turn.finalText, cursorAcpSource.reportedFailure), { status: "ready", lastStop: "end_turn" })
}

// An answer that ends with a tool call and then prose is an answer.
{
  const { turn, result } = await replay([...DROPPED_TURN.slice(0, -2), chunk("Both edits are in place.")])
  assert.deepEqual(turnVerdict(result, turn.finalText, cursorAcpSource.reportedFailure), { status: "ready", lastStop: "end_turn" })
}

// A non-retriable error the agent reports is a failure to send again, not a dropped connection.
{
  const { turn, result } = await replay([chunk("Working on it."), chunk("\n\nError: NonRetriableError: [invalid_argument] conversation too long")])
  const verdict = turnVerdict(result, turn.finalText, cursorAcpSource.reportedFailure)
  assert.equal(verdict.status, "failed")
  assert.equal(verdict.lastStop, "failed")
  assert.equal(verdict.error, "NonRetriableError: [invalid_argument] conversation too long")
}

// A Stop that lands as the error chunk arrives stays a Stop.
{
  const { turn, result } = await replay(DROPPED_TURN, "cancelled")
  assert.deepEqual(turnVerdict(result, turn.finalText, cursorAcpSource.reportedFailure), { status: "ready", lastStop: "cancelled" })
}

// A provider without the hook never sees its transcript reinterpreted.
{
  const { turn, result } = await replay(DROPPED_TURN)
  assert.deepEqual(turnVerdict(result, turn.finalText, undefined), { status: "ready", lastStop: "end_turn" })
}

// A prompt the transport itself failed keeps its own error.
assert.deepEqual(turnVerdict({ kind: "failed", error: "Disconnected after dispatch" }, `\n\n${CANCEL}`, cursorAcpSource.reportedFailure), {
  status: "failed",
  lastStop: "failed",
  error: "Disconnected after dispatch",
})

// The final text is bounded, and the error still ends it.
{
  const turn = new AcpPromptTurn(() => {})
  for (let i = 0; i < 200; i += 1) turn.noteText("x".repeat(100))
  turn.noteText(`\n\n${CANCEL}`)
  assert.ok(turn.finalText.length <= 4_096)
  assert.equal(cursorReportedFailure(turn.finalText), CANCEL.slice("Error: ".length))
}

console.log("Cursor reported failures: the real dropped-stream sequence settles as connection-lost; answers, Stops and other providers are untouched")

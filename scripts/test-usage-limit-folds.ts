import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeProvider } from "@mako/sessions"
import { entriesToMessages } from "../src/lib/entry-messages"
import { toExchanges, type Exchange } from "../src/lib/exchanges"
import { eventWords, limitWords } from "../src/lib/transcript-events"
import { claudeTaskTurn, parseClaudeTaskNotification } from "@mako/sessions/harnesses"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"

// A Claude Code orchestrator whose account limit stopped its background
// agents, saved as Claude Code 2.1 writes it: each agent's failure arrives as
// a task notification, Claude Code runs a turn on it, and the same limit
// refuses that turn. One limit is one line, whatever it stopped.
const home = await mkdtemp(join(tmpdir(), "mako-usage-limit-folds-"))
const session = "session-limit"
let clock = 0
/** The fields of Claude Code's records this session uses. */
interface ClaudeRecord {
  type: "user" | "assistant"
  uuid: string
  message: { id?: string; role: string; model?: string; content: string | Array<{ type: "text"; text: string }> }
  isApiErrorMessage?: boolean
  error?: string
  origin?: { kind: string }
}
const record = (value: ClaudeRecord) => JSON.stringify({
  sessionId: session, cwd: home, isSidechain: false,
  timestamp: new Date(Date.UTC(2026, 9, 13, 7, 0, clock++)).toISOString(), ...value,
})
const user = (uuid: string, text: string) => record({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] } })
const assistant = (uuid: string, text: string) => record({
  type: "assistant", uuid, message: { id: `msg-${uuid}`, role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text }] },
})
const SESSION_LIMIT = "You've hit your session limit · resets 3:20am (America/Los_Angeles)"
const refusal = (uuid: string, words = SESSION_LIMIT) => record({
  type: "assistant", uuid, isApiErrorMessage: true, error: "rate_limit",
  message: { id: `msg-${uuid}`, role: "assistant", model: "<synthetic>", content: [{ type: "text", text: words }] },
})
const notified = (uuid: string, status: string, summary: string) => record({
  type: "user", uuid, origin: { kind: "task-notification" },
  message: { role: "user", content: `<task-notification>\n<task-id>${uuid}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` },
})
const limitKilled = (uuid: string, name: string) =>
  notified(uuid, "failed", `Agent "${name}" failed: Agent terminated early due to an API error: ${SESSION_LIMIT} (error type rate_limit, HTTP 429)`)

const lines = [
  user("u1", "Start the four audits in the background"),
  assistant("a1", "Started four agents."),
  refusal("r0"),
  limitKilled("k1", "Audit decoders"),
  refusal("r1"),
  limitKilled("k2", "Audit watchers"),
  refusal("r2"),
  limitKilled("k3", "Audit drivers"),
  refusal("r3"),
  notified("c1", "completed", 'Background command "npm test" completed (exit code 0)'),
  refusal("r4"),
  // Another cause is news of its own, and Claude answered it.
  notified("k4", "failed", 'Agent "Audit usage" failed: Agent terminated early due to an API error: Overloaded (error type overloaded_error, HTTP 529)'),
  assistant("a2", "The usage audit hit an overloaded server; I'll rerun it."),
  user("u2", "Try again later"),
  refusal("r5"),
]
const path = join(home, `${session}.jsonl`)
await writeFile(path, `${lines.join("\n")}\n`)

try {
  const thread = await new ClaudeProvider(home).read(path)
  assert.ok(thread)
  const messages = entriesToMessages(thread.entries, { kind: "saved", provider: "claude" }).messages
  const exchanges = toExchanges(messages)
  const opening = (exchange: Exchange) => exchange.prompt ? "prompt" : exchange.opener?.note?.cause?.kind ?? "lead"
  assert.deepEqual(exchanges.map(opening), ["prompt", "agent", "prompt"],
    "the turns the limit refused fold into the turn that first reported it; another cause and a prompt stay their own")

  const [first, other, last] = [exchanges[0]!, exchanges[1]!, exchanges[2]!]
  const limits = first.system.filter((note) => note.message.note?.limit)
  assert.equal(limits.length, 1, "the limit is one line")
  const line = limits[0]!.message
  const refused = first.refused?.[line.id] ?? []
  assert.equal(refused.length, 4, "every turn it refused opens under that line")
  const words = limitWords(line.note!, refused.flatMap((opener) => opener.note?.cause ? [opener.note.cause] : []))
  assert.equal(words.title, "Rate limited")
  assert.equal(words.detail, `${SESSION_LIMIT} · 3 agents stopped · 1 background report not answered`)
  assert.deepEqual(refused.map((opener) => eventWords(opener.note!).detail), ["Audit decoders", "Audit watchers", "Audit drivers", "npm test"])

  // Claude Code stacks the reports nothing answered into the turn on the first; another cause in that stack stays, with its answer.
  assert.deepEqual(other.system.map((note) => eventWords(note.message.note!).detail), ["Audit usage"], "an agent another error ended is not the limit's")
  assert.equal(other.system[0]!.message.note?.cause?.kind === "agent" && other.system[0]!.message.note.cause.limit, undefined)
  assert.equal(other.response.length, 1)

  assert.equal(last.system.filter((note) => note.message.note?.limit).length, 1, "a prompt the limit refused says so on its own turn")
  assert.equal(last.refused, undefined)

  // Unchanged input keeps every exchange, folded ones included, so nothing redraws.
  const again = toExchanges(messages, exchanges)
  assert.ok(again.every((exchange, index) => exchange === exchanges[index]))

  // The limit's first refusal can itself be a turn the provider started: it counts among what it stopped.
  const alone = await new ClaudeProvider(home).read(path)
  assert.ok(alone)
  const fromAgent = toExchanges(entriesToMessages(alone.entries.filter((entry) => (entry.type !== "event" && entry.type !== "provider-turn") || entry.source?.record !== "r0"), { kind: "saved", provider: "claude" }).messages)
  const anchor = fromAgent[1]!
  const anchorLine = anchor.system.find((note) => note.message.note?.limit)!.message
  assert.equal(anchor.refused?.[anchorLine.id]?.length, 4, "the anchoring agent and the work folded after it")

  // Live, as the engine streams it: the same one line.
  const limitUpdate = { kind: "event", label: "Rate limited", detail: SESSION_LIMIT, tone: "warning", limit: {} } satisfies LiveUpdate
  const updates: LiveUpdate[] = [
    { kind: "user", text: "Start the audits" },
    { kind: "text", id: "t1", text: "Started." },
    { kind: "event", label: "Rate limited", detail: "Reached your 5-hour limit · resets 3:20am", tone: "warning", limit: { window: "5-hour limit", resetsAt: Date.UTC(2026, 9, 13, 10, 20) } },
    ...["Audit decoders", "Audit watchers", "Audit drivers"].flatMap((name, index): LiveUpdate[] => [
      { kind: "provider-turn", ...claudeTaskTurn(parseClaudeTaskNotification(`<task-notification>\n<task-id>l${index}</task-id>\n<status>failed</status>\n<summary>Agent "${name}" failed: Agent terminated early due to an API error: ${SESSION_LIMIT}</summary>\n</task-notification>`)!) },
      limitUpdate,
    ]),
  ]
  const live = toExchanges(entriesToMessages(reduceLiveUpdates([], updates), { kind: "live", running: false, provider: "claude" }).messages)
  assert.equal(live.length, 1, "live, the refused turns fold into the turn that reported the limit")
  const liveLine = live[0]!.system.filter((note) => note.message.note?.limit)
  assert.equal(liveLine.length, 1)
  assert.equal(live[0]!.refused?.[liveLine[0]!.message.id]?.length, 3)

  console.log("Usage limit folds: one line per limit for every turn and agent it refused; other causes and prompts stay their own; stable across reprojection")
} finally {
  await rm(home, { recursive: true, force: true })
}

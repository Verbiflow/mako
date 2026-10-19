import assert from "node:assert/strict"
import type { Thread } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import { transcriptDocument, type LiveHistory, type TranscriptDocumentDeps } from "@mako/host/conversations/transcript-document"

/**
 * A transcript tab reads a Session's native record, or, while it runs here,
 * the native history it resumed followed by its captured live blocks, never
 * the native file for turns the stream has and the file may not yet. It is
 * the transcript builder's copy for a person (`folded`): oldest first, each
 * call on one line, and at `concise` only what was said.
 */

const ref = { harness: "claude", nativeId: "n1", path: "/claude/n1.jsonl", title: "Fix the rail" } as const
const turn = (text: string, answer: string): Entry[] => [
  { type: "user", text },
  { type: "text", text: answer },
  { type: "tool", id: `edit-${text}`, name: "edit", status: "completed", output: "" },
]
const native: Thread = { ref, entries: [...turn("first ask", "first answer"), ...turn("second ask", "second answer"), ...turn("third ask", "a native line the stream also has")] }

function deps(live: LiveHistory | null, thread: Thread | null = native): TranscriptDocumentDeps & { opened: string[] } {
  const opened: string[] = []
  return { opened, snapshot: async () => live, openThread: async (path) => { opened.push(path); return thread }, label: (harness) => (harness === "claude" ? "Claude Code" : harness) }
}

const stored = await transcriptDocument(deps(null), { kind: "file", path: ref.path }, "concise")
assert.equal(stored.title, "Fix the rail")
assert.equal(stored.harness, "claude")
assert.match(stored.markdown, /^# Fix the rail\n\nClaude Code · 3 turns\n\n## Turn 1\n\n### User\nfirst ask\n\n### Agent\nfirst answer\n\n\(1 call not shown\)\n/, "a stored Session reads as its record: prompts, answers, and what was left out")
const full = await transcriptDocument(deps(null), { kind: "file", path: ref.path }, "full")
assert.match(full.markdown, /^- Call 1 edit$/m, "with tools, each tool call is a line")

const blocks: LiveHistory["blocks"] = [
  { type: "user", text: "covered by the base" },
  { type: "user", requestId: "r2", text: "live ask" },
  { type: "text", text: "live answer so far" },
]
const base = { ref, entries: native.entries.slice(2, 4), start: 2, total: 4, hasEarlier: true }
const resumed = deps({ session: { title: "Fix the rail", harness: "claude" }, base, baseCoveredBlocks: 1, blocks })
const running = await transcriptDocument(resumed, { kind: "live", id: "c1" }, "concise")
assert.deepEqual(resumed.opened, [ref.path], "a base page holding only the latest turns sends it to the record for the rest")
const order = ["first ask", "second ask", "live ask", "live answer so far"].map((text) => running.markdown.indexOf(text))
assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1]!)), "the resumed history in order, then the live turn")
assert.doesNotMatch(running.markdown, /covered by the base/, "blocks the base already holds are not repeated")
assert.doesNotMatch(running.markdown, /a native line the stream also has/, "the record past the base is the stream's to tell")

const whole = deps({ session: { harness: "codex" }, base: { ...base, entries: native.entries, start: 0, total: 6, hasEarlier: false }, blocks: [] })
const fresh = await transcriptDocument(whole, { kind: "live", id: "c2" }, "concise")
assert.deepEqual(whole.opened, [], "a base that starts at the beginning is enough")
assert.match(fresh.markdown, /^# Untitled conversation\n/, "an untitled Session still has a heading")

const empty = await transcriptDocument(deps({ session: { harness: "codex" }, base: null, blocks: [] }), { kind: "live", id: "c3" }, "concise")
assert.match(empty.markdown, /Nothing said yet\./)

await assert.rejects(transcriptDocument(deps(null), { kind: "live", id: "gone" }, "concise"), /isn't open on this Mac/, "a closed conversation says so, and the tab falls back to the record")
await assert.rejects(transcriptDocument(deps(null, null), { kind: "file", path: "/missing" }, "concise"), /could not be read/)

console.log("transcript document: stored records, live history after a partial or whole base, empty and gone Sessions")

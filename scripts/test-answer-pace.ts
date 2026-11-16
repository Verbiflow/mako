import assert from "node:assert/strict"
import type { Entry } from "@mako/sessions/entries"
import { flushFrameMs, LONG_ANSWER_CHARS, LONG_ANSWER_FLUSH_MS } from "@mako/host/conversations/answer-pace"

// When a conversation's pending changes go out: each frame, but for a long answer going on, at a reader's pace.
const frame = 50
const answer = (text: string): Entry[] => [{ type: "user", text: "Explain", requestId: "r1" }, { type: "text", id: "a1", text }]
const long = "word ".repeat(LONG_ANSWER_CHARS / 5)
const more = (text: string) => [{ kind: "text" as const, id: "a1", text }]

assert.equal(flushFrameMs(frame, answer("Short so far"), more(" and on"), false), frame, "a short answer goes each frame")
assert.equal(flushFrameMs(frame, answer(long), more("and on"), false), LONG_ANSWER_FLUSH_MS, "a long one at a reader's pace")
assert.equal(flushFrameMs(frame, answer("x".repeat(LONG_ANSWER_CHARS - 10)), more("y".repeat(20)), false), LONG_ANSWER_FLUSH_MS, "counting what waits")
assert.equal(flushFrameMs(frame, answer(long), more("end.\n\nNext"), false), frame, "a paragraph that ends goes on the frame")
assert.equal(flushFrameMs(frame, answer(`${long}end.\n`), more("\nNext"), false), frame, "even split across updates")
assert.equal(flushFrameMs(frame, answer(long), more("and on"), true), frame, "anything else of the conversation changed")
assert.equal(flushFrameMs(frame, answer(long), [...more("and on"), { kind: "thinking", id: "t1", text: "hm" }], false), frame, "another kind of update")
assert.equal(flushFrameMs(frame, answer(long), [{ kind: "text", id: "a1", text: "redo", replace: true }], false), frame, "a rewrite")
assert.equal(flushFrameMs(frame, answer(long), [{ kind: "text", id: "a2", text: "another" }], false), frame, "another block")
assert.equal(flushFrameMs(frame, answer(long), [], false), frame, "nothing waits")
assert.equal(flushFrameMs(frame, [{ type: "user", text: "Explain", requestId: "r1" }], more("first"), false), frame, "the first words")

console.log("answer pace: a long answer going on waits for a reader's pace; its first words, a short answer, a paragraph's end and anything else go each frame")

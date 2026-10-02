import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { OPENCODE_IMPORTED_MODEL, openCodeImport } from "../dist/emit.js"

const thread = {
  ref: { harness: "codex", nativeId: "source", path: "/source", title: "Parser work", cwd: "/work", startedAt: "2026-10-01T10:00:00.000Z" },
  entries: [
    { kind: "user", text: "The codeword is heliotrope. Read the parser.", at: "2026-10-01T10:00:00.000Z" },
    { kind: "assistant", at: "2026-10-01T10:00:05.000Z", blocks: [
      { type: "tool", name: "shell", input: "cat parser.ts", output: "export function parse() {}" },
      { type: "text", text: "The parser exports one function." },
    ] },
    { kind: "user", text: "Thanks.", at: "2026-10-01T10:00:05.000Z" },
    { kind: "assistant", blocks: [{ type: "text", text: "Anytime." }] },
  ],
}

const home = mkdtempSync(join(tmpdir(), "mako-opencode-emit-"))
try {
  const { sessionId, directory, document } = await openCodeImport(thread, { home })
  assert.equal(directory, "/work")
  assert.equal(document.info.id, sessionId)
  assert.equal(document.info.title, "Parser work")
  assert.deepEqual(document.info.location, { directory: "/work" })
  assert.equal(document.info.time.created, Date.parse("2026-10-01T10:00:00.000Z"))

  const { messages } = document
  assert.deepEqual(messages.map((message) => message.type), ["user", "assistant", "user", "assistant"])
  assert.match(messages[0].text, /codeword is heliotrope/)
  const said = messages[1].content.map((part) => part.text).join("\n")
  assert.match(said, /\[tool: shell\]/, "tool activity replays as text")
  assert.match(said, /exports one function/)
  for (const message of messages.filter((message) => message.type === "assistant")) {
    assert.equal(message.agent, "build", "OpenCode's import refuses an assistant turn without an agent")
    assert.deepEqual(message.model, OPENCODE_IMPORTED_MODEL, "a resumed session runs on the user's default model")
    assert.equal(message.finish, "stop")
  }

  const times = messages.map((message) => message.time.created)
  assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]), "times ascend even when stamps tie or are missing")
  const ids = messages.map((message) => message.id)
  assert.ok(ids.every((id) => /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id)), "message ids take OpenCode's shape")
  assert.deepEqual([...ids].sort(), ids, "message ids ascend with time")
  assert.match(sessionId, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)

  const later = await openCodeImport({ ...thread, ref: { ...thread.ref, startedAt: "2026-10-02T10:00:00.000Z" } }, { home })
  assert.ok(later.sessionId < sessionId, "a later session sorts first, as OpenCode lists them")
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log("OpenCode emit: a thread becomes the session `opencode session import` takes, in OpenCode's ids and order")

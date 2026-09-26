// Diagnostic: asserts the known defects, not the desired behavior.
// Run from the repository root with node_modules/.bin/tsx.
import assert from "node:assert/strict"
import { defaultUrlTransform } from "react-markdown"
import { markdownFileTarget, linkFileCitations } from "../../../src/lib/file-citations.ts"
import { buildForeignPrompt, parseAttachmentAppendix } from "../../../src/lib/attachments.ts"
import { forward } from "../../../electron/acp-notifications.ts"
import { parseNotification } from "../../../electron/codex-app-parse.ts"
import { userTextFrom } from "../../../packages/sessions/src/format.ts"

assert.deepEqual(markdownFileTarget("/work/src/a.ts:42"), {
  path: "/work/src/a.ts:42", line: undefined, endLine: undefined,
})
assert.equal(markdownFileTarget("a.ts:42"), null)
assert.equal(defaultUrlTransform("file:///work/a.ts"), "")
assert.equal(defaultUrlTransform("vscode://file/work/a.ts:42"), "")
console.log("CONFIRMED colon line suffix becomes part of the filename; file/editor schemes are stripped")

const code = '```text\n:codex-file-citation{path="/work/a.ts"}\n```'
assert.notEqual(linkFileCitations(code), code)
assert.ok(linkFileCitations(code).includes("mako-citation:"))
console.log("CONFIRMED citation preprocessing rewrites literal fenced-code contents")

const textAttachment = {
  id: "text", index: 1, name: "notes.txt", mimeType: "text/plain",
  size: 6, kind: "text", text: "SECRET", pending: false,
}
const imageAttachment = {
  id: "image", index: 2, name: "image.png", mimeType: "image/png",
  size: 1, kind: "image", stagedPath: "/tmp/synthetic-image.png", pending: false,
}
const parsed = parseAttachmentAppendix(buildForeignPrompt("Compare these", [textAttachment, imageAttachment]))
assert.equal(parsed.body, "Compare these")
assert.deepEqual(parsed.files, [{ name: "image.png", path: "/tmp/synthetic-image.png" }])
assert.ok(!JSON.stringify(parsed).includes("notes.txt"))
console.log("CONFIRMED mixed attachment appendix hides the text attachment without a chip")

const failedStage = buildForeignPrompt("Inspect [Attachment 2]", [{ ...imageAttachment, stagedPath: undefined }])
assert.ok(failedStage.includes("could not be staged; ask for it again"))
console.log("CONFIRMED failed image staging still constructs a sendable prompt without the image")

const events = []
const send = (update) => forward({ id: "synthetic" }, { sessionId: "synthetic", update }, e => events.push(e), () => {})
send({ sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: "eA==" } })
send({ sessionUpdate: "user_message_chunk", content: { type: "resource_link", name: "file", uri: "file:///tmp/example.txt" } })
assert.equal(events.length, 0)
send({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed", content: [{ type: "content", content: { type: "text", text: "actual tool output" } }] })
assert.equal(events[0].update.output, undefined)
console.log("CONFIRMED ACP image/resource chunks vanish; standard tool content is ignored without rawOutput")

const user = parseNotification("item/completed", {
  threadId: "thread", turnId: "turn", item: { type: "userMessage", id: "user", content: [{ type: "localImage", path: "/tmp/synthetic-image.png" }] },
})
assert.deepEqual(user.item.content, [{ type: "localImage" }])
const image = parseNotification("item/completed", {
  threadId: "thread", turnId: "turn", item: { type: "imageView", id: "image", path: "/tmp/synthetic-image.png" },
})
assert.equal(image.item.type, "unsupported")
console.log("CONFIRMED Codex replay drops localImage paths and maps imageView to unsupported")

assert.equal(userTextFrom("<recommended_plugins>\nlist\n</recommended_plugins>\n\nPlease audit this project."), undefined)
console.log("CONFIRMED a user request following a leading injected envelope is discarded with the envelope")

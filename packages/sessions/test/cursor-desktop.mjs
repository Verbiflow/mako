import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CursorProvider } from "../dist/providers/cursor.js"
import { ThreadRefSchema } from "../dist/thread-schema.js"

const home = await mkdtemp(join(tmpdir(), "mako-cursor-desktop-"))
try {
  const root = join(home, process.platform === "darwin" ? "Library/Application Support/Cursor/User/globalStorage" : process.platform === "win32" ? "AppData/Roaming/Cursor/User/globalStorage" : ".config/Cursor/User/globalStorage")
  await mkdir(root, { recursive: true })
  const db = new DatabaseSync(join(root, "state.vscdb"))
  db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, lastUpdatedAt INTEGER, checkpointAt INTEGER, isSubagent INTEGER, value TEXT); CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)")
  const id = "12345678-1234-1234-1234-123456789abc"
  const header = {composerId: id, name: "Saved architecture review", createdAt: 1700000000000, lastUpdatedAt: 1700000001000, workspaceIdentifier: {uri: {fsPath: home}}}
  db.prepare("INSERT INTO composerHeaders VALUES (?,?,?,?,?)").run(id, header.lastUpdatedAt, 1, 0, JSON.stringify(header))
  const childId = "22345678-1234-1234-1234-123456789abc"
  const childHeader = {composerId: childId, name: "Task subagent", createdAt: 1700000002000, lastUpdatedAt: 1700000003000, workspaceIdentifier: {uri: {fsPath: home}}}
  db.prepare("INSERT INTO composerHeaders VALUES (?,?,?,?,?)").run(childId, childHeader.lastUpdatedAt, 1, 1, JSON.stringify(childHeader))
  const write = (key, value) => db.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)").run(key, JSON.stringify(value))
  const bubbles = [
    {bubbleId: "user", type: 1, text: "Explain the architecture", images: [{filePath: join(home, "proof.png")}]},
    {bubbleId: "thinking", type: 2, thinking: {text: "**Inspecting** the modules"}},
    {bubbleId: "tool", type: 2, toolFormerData: {name: "read_file_v2", toolCallId: "call-1", params: '{"path":"app.ts"}', result: "", status: "completed"}},
    {bubbleId: "reply", type: 2, text: "The architecture has three layers."},
    {bubbleId: "oversized", type: 2, text: "x".repeat(2 * 1024 * 1024)},
  ]
  for (const bubble of bubbles) write(`bubbleId:${id}:${bubble.bubbleId}`, bubble)
  write(`composerData:${id}`, {fullConversationHeadersOnly: bubbles.map(({bubbleId}) => ({bubbleId})), modelConfig: {modelName: "provider-model"}, activeCanvas: {path: join(home, "architecture.canvas.tsx")}})
  db.close()
  const provider = new CursorProvider(home)
  const files = await provider.discover()
  assert.equal(files.length, 1)
  assert.equal(files[0].path.endsWith(id), true)
  assert.equal(
    await provider.peek({
      path: files[0].path.replace(id, childId),
      bytes: 0,
      mtimeMs: childHeader.lastUpdatedAt,
    }),
    null,
    "Desktop subagent composers are not threads"
  )
  const ref = await provider.peek(files[0])
  assert.equal(ref.title, header.name)
  assert.equal(ref.cwd, home)
  assert.equal(ref.archived, undefined, "Desktop history remains eligible for archival")
  assert.ok(ref.resumeUnavailable, "Desktop IDs must never be sent to the CLI resume transport")
  assert.equal(ThreadRefSchema.parse(ref).resumeUnavailable, ref.resumeUnavailable)
  const thread = await provider.read(ref.path)
  assert.equal(thread.ref.model, "provider-model")
  assert.equal(thread.entries[0].attachments[0].source.path, join(home, "proof.png"))
  assert.equal(thread.entries[1].blocks[0].type, "thinking")
  assert.equal(thread.entries[2].blocks[0].output, "")
  assert.equal(thread.entries[3].blocks[0].text, bubbles[3].text)
  assert.equal(thread.entries[4].label, "Message unavailable", "Oversized native records produce an explicit marker")
  assert.equal(thread.entries.at(-1).blocks[0].mimeType, "text/x-cursor-canvas")
  assert.equal(thread.entries.at(-1).blocks[0].source.path, join(home, "architecture.canvas.tsx"))
  const follower = provider.createFollower(ref.path, 0)
  assert.deepEqual((await follower.next()).entries, [], "Opening an unchanged history is not streaming activity")
  const writer = new DatabaseSync(join(root, "state.vscdb"))
  writer.prepare("UPDATE composerHeaders SET checkpointAt = 2 WHERE composerId = ?").run(id)
  writer.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?").run(JSON.stringify({...bubbles[3], text: "Updated answer"}), `bubbleId:${id}:reply`)
  writer.close()
  const update = await follower.next()
  assert.equal(update.replace, true)
  assert.equal(update.replaceFrom, 3)
  assert.equal(update.entries[0].blocks[0].text, "Updated answer")
  assert.ok(update.entries.length < thread.entries.length, "A late edit must not resend the unchanged prefix")
  assert.deepEqual((await follower.next()).entries, [], "A delivered revision is not replayed again")
  const correction = new DatabaseSync(join(root, "state.vscdb"))
  correction.prepare("UPDATE composerHeaders SET checkpointAt = 3 WHERE composerId = ?").run(id)
  correction.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?").run(JSON.stringify({...bubbles[3], text: "Updated answeR"}), `bubbleId:${id}:reply`)
  correction.close()
  const corrected = await follower.next()
  assert.equal(corrected.replaceFrom, 3)
  assert.equal(corrected.entries[0].blocks[0].text, "Updated answeR", "Equal-length edits are not mistaken for unchanged text")
  assert.equal(await provider.read(ref.path.replace(id, "../../foreign")), null)
  console.log("Cursor desktop discovery and bounded message reads preserve text, tools, media, Canvas, and continuation limits")

  // Shapes recorded from Cursor Desktop's state.vscdb on 2026-09-29: what
  // Cursor wrote in the user's place, the summary it compacted to, and the
  // errors a reply ended on.
  const eventsId = "32345678-1234-1234-1234-123456789abc"
  const events = new DatabaseSync(join(root, "state.vscdb"))
  events.prepare("INSERT INTO composerHeaders VALUES (?,?,?,?,?)").run(eventsId, 1700000004000, 1, 0, JSON.stringify({...header, composerId: eventsId, name: "Events"}))
  const notification = "<timestamp>Today</timestamp>\n<system_notification>\nThe following task has finished. If you were already aware, ignore this notification and do not restate prior responses.\n\n<task>\nkind: shell\nstatus: error\ntask_id: 14171\ntitle: Run the checks\n</task>\n</system_notification>\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed).</user_query>"
  const explained = JSON.stringify({error: "ERROR_CONVERSATION_TOO_LONG", details: {title: "Conversation Too Long", detail: "Your conversation is too long. Please try creating a new conversation or shortening your messages.", isRetryable: false}, isExpected: true})
  const eventBubbles = [
    {bubbleId: "ask", type: 1, text: "Plan the refactor", toolFormerData: {additionalData: {status: "error"}}},
    {bubbleId: "plan", type: 1, isSimulatedMsg: true, simulatedMsgReason: 1, text: "Refactor plan\n\nImplement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself."},
    {bubbleId: "summarised", type: 2, text: "Continuing.", conversationSummary: {summary: "The user asked for a refactor plan.", truncationLastBubbleIdInclusive: "ask"}},
    {bubbleId: "again", type: 2, text: "Still going.", conversationSummary: {summary: "The user asked for a refactor plan."}},
    {bubbleId: "too-long", type: 2, errorDetails: {generationUUID: "g1", error: explained, message: "Error"}},
    {bubbleId: "stopped", type: 2, errorDetails: {message: "Canceled"}},
    {bubbleId: "dropped", type: 2, errorDetails: {message: "Error [unavailable]"}},
    {bubbleId: "notice", type: 1, isSimulatedMsg: true, simulatedMsgReason: 3, text: notification},
    {bubbleId: "nudge", type: 1, isNudge: true, text: "Also fix the header"},
  ]
  for (const bubble of eventBubbles) events.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)").run(`bubbleId:${eventsId}:${bubble.bubbleId}`, JSON.stringify(bubble))
  events.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)").run(`composerData:${eventsId}`, JSON.stringify({fullConversationHeadersOnly: eventBubbles.map(({bubbleId}) => ({bubbleId}))}))
  events.close()
  const read = (await provider.read(ref.path.replace(id, eventsId))).entries
  const outline = read.map((entry) => entry.kind === "event"
    ? `event${entry.opensTurn ? ":opens" : ""}${entry.tone ? `:${entry.tone}` : ""}:${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}`
    : entry.kind === "user" ? `user:${entry.text}` : `assistant:${entry.blocks.map((block) => block.text).join("")}`)
  assert.deepEqual(outline, [
    "user:Plan the refactor",
    "event:opens:Implement plan — Refactor plan",
    "event:Context compacted",
    "assistant:Continuing.",
    "assistant:Still going.",
    "event:error:Turn failed — Conversation Too Long",
    "event:Interrupted",
    "event:error:Turn failed — Error [unavailable]",
    'event:opens:error:Background command "Run the checks" failed',
    "user:Also fix the header",
  ])
  assert.equal(read[2].body, "The user asked for a refactor plan.", "the summary is the marker's body, once per summary")
  assert.equal(read[5].body, "Your conversation is too long. Please try creating a new conversation or shortening your messages.")
  assert.match(read[1].body, /Implement the plan as specified/, "Cursor's canned instruction is kept, but not as the user's words")
  console.log("Cursor desktop: simulated messages open turns in Cursor's words, a summary marks its compaction, error replies mark failed turns, and a nameless tool record costs nothing")
} finally {
  await rm(home, {recursive: true, force: true})
}

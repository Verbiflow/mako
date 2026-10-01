import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpServer, OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { normalizeOpenCodeModels } from "@mako/sessions/model-catalog"
import { OpenCodeContent } from "../electron/providers/opencode/content.ts"
import { OpenCodeInteractions, openCodePermissionReply, type OpenCodeRequestClient } from "../electron/providers/opencode/interactions.ts"
import { openCodeRequestedModel } from "../electron/providers/opencode/catalog.ts"
import { createOpenCodeDriver, openCodeMessageId } from "../electron/providers/opencode/live-driver.ts"
import { OpenCodeMcpHealth, openCodeIgnores, openCodeStopped } from "../electron/providers/opencode/notices.ts"
import { flushHostLog, installHostLog } from "../electron/host-log.ts"
import type { LiveDriverEvent } from "../electron/shared.ts"
import type { ApprovalSubmission } from "../electron/contracts/approval-response.ts"
import type { JsonValue } from "../electron/codex-app-json.ts"
import { z } from "zod"

/** Native event data; an `undefined` field is one the native event leaves out. */
type EventData = Record<string, JsonValue | undefined>
// SAFETY: each fixture spells out the native fields the projection and interactions read for its `type`.
const event = (type: string, data: EventData) => ({ id: randomUUID(), created: Date.now(), type, data }) as OpenCodeEvent
const root = "ses_root"
const child = "ses_child"
const cwd = "/work"
const message = "msg_assistant"

// Content projection.
{
  const content = new OpenCodeContent(root, cwd)
  assert.deepEqual(content.observe(event("session.text.delta", { sessionID: root, assistantMessageID: message, ordinal: 0, delta: "Hi" })),
    [{ kind: "text", id: `${message}:0`, text: "Hi" }])
  assert.deepEqual(content.observe(event("session.reasoning.delta", { sessionID: root, assistantMessageID: message, ordinal: 1, delta: "hm" })),
    [{ kind: "thinking", id: `${message}:reasoning:1`, text: "hm" }])
  assert.deepEqual(content.observe(event("session.text.delta", { sessionID: child, assistantMessageID: "msg_c", ordinal: 0, delta: "child prose" })), [],
    "a child's prose stays in its own session")

  const started = content.observe(event("session.tool.input.started", { sessionID: root, assistantMessageID: message, id: "t1", name: "bash" }))
  assert.deepEqual(started, [{ kind: "tool", id: `${root}:t1`, title: "bash", toolKind: "execute", status: "pending" }])
  const [called] = content.observe(event("session.tool.called", { sessionID: root, assistantMessageID: message, id: "t1", input: { command: "ls -la" }, executed: false }))
  assert.equal(called.kind, "tool-update")
  assert.equal(called.kind === "tool-update" && called.title, "ls -la")
  assert.equal(called.kind === "tool-update" && called.status, "in_progress")
  assert.equal(content.title(root, "t1"), "ls -la")
  assert.equal(content.name(root, "t1"), "bash")
  const [done] = content.observe(event("session.tool.success", { sessionID: root, assistantMessageID: message, id: "t1",
    content: [{ type: "text", text: "total 0" }, { type: "file", uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png", name: "shot.png" }] }))
  assert.equal(done.kind === "tool-update" && done.status, "completed")
  assert.equal(done.kind === "tool-update" && done.output, "total 0")
  assert.equal(done.kind === "tool-update" && done.attachments?.length, 1, "file parts become attachments")
  assert.equal(content.name(root, "t1"), undefined, "the result closes the call")

  content.nameSession(child, "Explore the repo")
  assert.equal(content.prefix(child), "Explore the repo: ")
  const childRow = content.observe(event("session.tool.input.started", { sessionID: child, assistantMessageID: "msg_c", id: "t1", name: "read" }))
  assert.deepEqual(childRow, [{ kind: "tool", id: `${child}:t1`, title: "Explore the repo: read", toolKind: "read", status: "pending" }],
    "a child's call ID never collides with its parent's")
  const [childCalled] = content.observe(event("session.tool.called", { sessionID: child, assistantMessageID: "msg_c", id: "t1", input: { filePath: "src/a.ts" }, executed: false }))
  assert.deepEqual(childCalled.kind === "tool-update" && childCalled.details, [{ type: "location", path: "/work/src/a.ts" }])
  assert.equal(childCalled.kind === "tool-update" && childCalled.title, "Explore the repo: src/a.ts")

  const unknown: string[] = []
  assert.deepEqual(content.observe(event("session.step.started", { sessionID: root }), (type) => unknown.push(type)), [])
  assert.deepEqual(content.observe(event("session.future.thing", { sessionID: root }), (type) => unknown.push(type)), [])
  assert.deepEqual(unknown, ["session.future.thing"], "only an event the projection does not know is reported")

  content.observe(event("session.tool.input.started", { sessionID: root, assistantMessageID: message, id: "w", name: "write" }))
  const [write] = content.observe(event("session.tool.called", { sessionID: root, assistantMessageID: message, id: "w", input: { filePath: "/abs/new.txt", content: "fresh" }, executed: false }))
  assert.deepEqual(write.kind === "tool-update" && write.details, [{ type: "location", path: "/abs/new.txt" }, { type: "diff", path: "/abs/new.txt", oldText: null, newText: "fresh" }])
  content.observe(event("session.tool.input.started", { sessionID: root, assistantMessageID: message, id: "e", name: "edit" }))
  const [edit] = content.observe(event("session.tool.called", { sessionID: root, assistantMessageID: message, id: "e", input: { filePath: "b.txt", oldString: "a", newString: "b" }, executed: false }))
  assert.deepEqual(edit.kind === "tool-update" && edit.details?.[1], { type: "diff", path: "/work/b.txt", oldText: "a", newText: "b" })
  content.observe(event("session.tool.input.started", { sessionID: root, assistantMessageID: message, id: "todo", name: "todowrite" }))
  const todo = content.observe(event("session.tool.called", { sessionID: root, assistantMessageID: message, id: "todo", input: { todos: [{ content: "Ship it", status: "pending" }] }, executed: false }))
  assert.deepEqual(todo.find(update => update.kind === "plan"), { kind: "plan", entries: [{ content: "Ship it", status: "pending" }] })

  assert.deepEqual(content.observe(event("session.tool.input.started", { sessionID: root, assistantMessageID: message, id: "q", name: "question" })),
    [{ kind: "tool", id: `${root}:q`, title: "question", toolKind: "question", status: "pending" }], "the question leaves a row beside its form")
  const [asked] = content.observe(event("session.tool.called", { sessionID: root, assistantMessageID: message, id: "q", executed: false,
    input: { questions: [{ header: "Colour", question: "Which colour?", options: [{ label: "red", description: "" }], multiple: false }] } }))
  assert.equal(asked.kind === "tool-update" && asked.title, "Which colour?", "the row names the question it asked")

  const [failed] = content.observe(event("session.tool.failed", { sessionID: root, assistantMessageID: message, id: "e", error: { type: "tool", message: "no match" }, content: [{ type: "text", text: "detail" }] }))
  assert.equal(failed.kind === "tool-update" && failed.status, "failed")
  assert.equal(failed.kind === "tool-update" && failed.output, "no match\ndetail")
  content.observe(event("session.tool.input.started", { sessionID: root, assistantMessageID: message, id: "stopped", name: "bash" }))
  const [stopped] = content.observe(event("session.tool.failed", { sessionID: root, assistantMessageID: message, id: "stopped", error: { type: "aborted", message: "Tool execution interrupted" } }))
  assert.equal(stopped.kind === "tool-update" && stopped.status, "cancelled", "a call the user stopped reads as cancelled, not failed")

  // A resubscribed stream first sees a call at its result; the driver opens it under its native name.
  assert.deepEqual(content.open(root, "late", "grep"), [{ kind: "tool", id: `${root}:late`, title: "grep", toolKind: "grep", status: "pending" }])
  assert.deepEqual(content.open(root, "late", "grep"), [], "opening is idempotent")
  const [lateCalled] = content.observe(event("session.tool.called", { sessionID: root, assistantMessageID: message, id: "late", input: { pattern: "TODO" }, executed: false }))
  assert.equal(lateCalled.kind === "tool-update" && lateCalled.title, "TODO")
  assert.equal(content.open(root, "late-question", "question").length, 1)
  const [answered] = content.observe(event("session.tool.success", { sessionID: root, assistantMessageID: message, id: "late-question",
    content: [{ type: "text", text: "User has answered your questions: \"Which colour?\"=\"red\"." }] }))
  assert.equal(answered.kind === "tool-update" && answered.output, "User has answered your questions: \"Which colour?\"=\"red\".",
    "the answered row keeps the answer after its form closes")

  const settled = content.settle(root, "cancelled", "Stopped before this call finished.")
  assert.deepEqual(new Set(settled.map(update => update.id)), new Set([`${root}:w`, `${root}:todo`, `${root}:q`, `${root}:late`]),
    "settling ends every open row in the session, an unanswered question included")
  assert.ok(settled.every(update => update.kind === "tool-update" && update.status === "cancelled" && !update.unfinished))
  assert.equal(content.name(child, "t1"), "read", "settling one session leaves another's calls open")
  const cutOff = content.settle(child, "failed", "OpenCode ended the turn before this call finished: exited")
  assert.ok(cutOff.length > 0 && cutOff.every(update => update.kind === "tool-update" && update.unfinished),
    "a failed turn's open calls never returned; a stopped one's were stopped")

  // A Plan step that ends the turn: its streamed reply folds into the plan card.
  const planning = new OpenCodeContent(root, cwd)
  const step = (id: string, agent: string) => planning.observe(event("session.step.started", { sessionID: root, assistantMessageID: id, agent,
    model: { id: "m", providerID: "p" } }))
  const text = (id: string, ordinal: number, value: string) =>
    planning.observe(event("session.text.ended", { sessionID: root, assistantMessageID: id, ordinal, text: value }))
  const ended = (id: string, finish: string, sessionID = root) => planning.observe(event("session.step.ended", { sessionID, assistantMessageID: id, finish,
    cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }))
  assert.deepEqual(step("msg_look", "plan"), [])
  text("msg_look", 0, "Let me read the code first.")
  assert.deepEqual(ended("msg_look", "tool-calls"), [], "a step that goes on to call tools is not the plan")
  step("msg_plan", "plan")
  text("msg_plan", 1, "## Steps\n1. Add `hello()`.")
  text("msg_plan", 0, "# Plan: Add a greeting\n")
  assert.deepEqual(ended("msg_plan", "stop"), [
    { kind: "retract", ids: ["msg_plan:0", "msg_plan:1"] },
    { kind: "proposed-plan", id: "opencode:msg_plan", text: "# Plan: Add a greeting\n\n## Steps\n1. Add `hello()`.", status: "proposed", replace: true },
  ], "the final Plan reply, in part order, replaces its streamed text")
  step("msg_build", "build")
  text("msg_build", 0, "Done.")
  assert.deepEqual(ended("msg_build", "stop"), [], "another agent's reply stays prose")
  step("msg_empty", "plan")
  assert.deepEqual(ended("msg_empty", "stop"), [], "a Plan step with no text has no plan")
  assert.deepEqual(ended("msg_child", "stop", child), [], "a child session's step is not the conversation's plan")

  const bounded = new OpenCodeContent(root, cwd)
  for (let index = 0; index <= 4096; index++)
    bounded.observe(event("session.tool.input.started", { sessionID: root, assistantMessageID: message, id: `b${index}`, name: "bash" }))
  assert.equal(bounded.name(root, "b0"), undefined, "the oldest open call leaves first")
  assert.equal(bounded.name(root, "b4096"), "bash")
}

// Native requests: permissions and forms.
const store = await mkdtemp(join(tmpdir(), "mako-opencode-projection-"))
try {
  const calls: Array<[string, unknown]> = []
  let openPermissions: unknown[] = []
  let whileReadingState: (() => Promise<void>) | undefined
  type FormReply = Parameters<OpenCodeRequestClient["form"]["reply"]>[0]
  const formStates = new Map<string, { status: "answered"; answer: FormReply["answer"] } | { status: "cancelled" }>()
  // SAFETY: OpenCodeInteractions calls only these methods; their results follow the native shapes.
  const client = {
    permission: {
      reply: async (input: Parameters<OpenCodeClient["permission"]["reply"]>[0]) => { calls.push(["permission.reply", input]) },
      list: async () => openPermissions,
    },
    form: {
      reply: async (input: FormReply) => { calls.push(["form.reply", input]); formStates.set(input.formID, { status: "answered", answer: input.answer }) },
      cancel: async (input: { formID: string }) => { calls.push(["form.cancel", input]); formStates.set(input.formID, { status: "cancelled" }) },
      list: async () => [],
      state: async (input: { formID: string }) => {
        const during = whileReadingState
        whileReadingState = undefined
        await during?.()
        return formStates.get(input.formID) ?? { status: "pending" }
      },
    },
  } as OpenCodeRequestClient
  const emitted: LiveDriverEvent[] = []
  const dispatch = () => {
    const reports: ApprovalSubmission[] = []
    return { reports, assertCurrent() {}, report: (result: ApprovalSubmission) => { reports.push(result) } }
  }
  const interactions = new OpenCodeInteractions({
    client, root: store, conversationId: "conversation",
    owns: sessionID => sessionID === root || sessionID === child,
    emit: item => { emitted.push(item) },
    describe: (sessionID, toolID) => ({ title: toolID === "call_1" ? "rm -rf build" : undefined, prefix: sessionID === child ? "Explore: " : "" }),
  })
  const asked = (id: string, sessionID = root, extra: EventData = {}) => event("permission.asked", {
    id, sessionID, action: "bash", resources: ["rm -rf build"], save: ["rm *", "*"], metadata: {}, source: { type: "tool", messageID: message, id: "call_1" }, ...extra })
  const requests = () => emitted.flatMap(item => item.type === "live-permission" ? [item.request] : [])

  await interactions.observe(asked("per_1"))
  const [request] = requests()
  assert.equal(request.title, "rm -rf build", "the asking tool's row title names the request")
  assert.equal(request.kind, "execute")
  assert.deepEqual(request.native, { scope: request.native!.scope, sessionId: root, requestId: "per_1" })
  assert.deepEqual(request.options.map(option => [option.optionId, option.name]), [["once", "Allow once"], ["always", "Always allow rm *"], ["reject", "Reject"]],
    "Always names the patterns OpenCode will save, never the catch-all")

  const invalid = dispatch()
  await interactions.respond(request.id, { kind: "choice", optionId: "sometimes" }, invalid)
  assert.deepEqual(invalid.reports, [{ kind: "not-submitted", pending: true, reason: "invalid-answer" }])
  const once = dispatch()
  await interactions.respond(request.id, { kind: "choice", optionId: "once" }, once)
  assert.deepEqual(once.reports, [{ kind: "submitted", source: "transport-write" }])
  assert.deepEqual(calls.at(-1), ["permission.reply", { sessionID: root, requestID: "per_1", reply: "once" }])
  const again = dispatch()
  await interactions.respond(request.id, { kind: "choice", optionId: "once" }, again)
  assert.deepEqual(again.reports, [{ kind: "uncertain", reason: "This answer was already dispatched" }], "an answer in flight is never sent twice")
  assert.deepEqual(openCodePermissionReply(root, "per_1", "reject"), { sessionID: root, requestID: "per_1", reply: "reject", message: "The user declined this tool request" },
    "a decline returns to the model, as in every other harness")
  assert.deepEqual(openCodePermissionReply(root, "per_1", null), { sessionID: root, requestID: "per_1", reply: "reject" }, "only a dismissed request stops the turn")

  await interactions.observe(event("permission.replied", { sessionID: root, requestID: "per_1", reply: "once" }))
  assert.ok(emitted.some(item => item.type === "live-permission-ended" && item.requestId === request.id && item.source === "native-resolution"))
  assert.ok(emitted.some(item => item.type === "live-approval-decision"), "the native decision is retained")
  const count = requests().length
  await interactions.observe(asked("per_1"))
  assert.equal(requests().length, count, "a resolved request is not shown again")
  const late = dispatch()
  await interactions.respond(request.id, { kind: "choice", optionId: "once" }, late)
  assert.deepEqual(late.reports, [{ kind: "not-submitted", pending: false, reason: "request-ended" }])

  await interactions.observe(asked("per_2", child, { source: undefined, message: undefined }))
  assert.equal(requests().at(-1)!.title, "Explore: rm -rf build", "a child's request carries its session label")
  await interactions.observe(asked("per_other", "ses_foreign"))
  assert.equal(requests().at(-1)!.native!.requestId, "per_2", "another conversation's request is not shown")

  openPermissions = []
  await interactions.reconcile(child)
  assert.ok(emitted.some(item => item.type === "live-permission-ended" && item.requestId === requests().at(-1)!.id && item.source === "native-resolution"),
    "a permission that vanished during a gap was resolved natively")

  await interactions.observe(event("form.created", { form: { id: "frm_1", sessionID: root, title: "Pick a colour",
    fields: [{ key: "colour", type: "string", title: "Colour", required: true, options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] }] } }))
  const form = requests().at(-1)!
  assert.equal(form.title, "Pick a colour")
  assert.equal(form.questions?.[0].id, "colour")
  const answered = dispatch()
  await interactions.respond(form.id, { kind: "answers", answers: { colour: ["blue"] } }, answered)
  assert.deepEqual(answered.reports, [{ kind: "submitted", source: "transport-write" }])
  assert.deepEqual(calls.at(-1), ["form.reply", { sessionID: root, formID: "frm_1", answer: { colour: "blue" } }])
  assert.ok(emitted.some(item => item.type === "live-permission-ended" && item.requestId === form.id && item.source === "native-resolution"),
    "the native form state resolves the request even before its event")

  await interactions.observe(event("form.created", { form: { id: "frm_2", sessionID: root, title: "Skip me", fields: [{ key: "x", type: "string" }] } }))
  const skipped = requests().at(-1)!
  await interactions.respond(skipped.id, { kind: "choice", optionId: null }, dispatch())
  assert.deepEqual(calls.at(-1), ["form.cancel", { sessionID: root, formID: "frm_2" }])

  await interactions.observe(event("form.created", { form: { id: "frm_3", sessionID: root, title: "Still open", fields: [{ key: "x", type: "string" }] } }))
  whileReadingState = () => interactions.observe(asked("per_late"))
  await interactions.reconcile(root)
  const askedDuring = requests().find(item => item.native?.requestId === "per_late")
  assert.ok(askedDuring, "a request asked during reconciliation is shown")
  assert.ok(!emitted.some(item => item.type === "live-permission-ended" && item.requestId === askedDuring.id),
    "a request asked while reconciliation waits is not ended as resolved")
  await interactions.observe(event("permission.replied", { sessionID: root, requestID: "per_late", reply: "once" }))
  await interactions.observe(event("form.cancelled", { sessionID: root, id: "frm_3" }))

  for (let index = 0; index < 300; index++) await interactions.observe(asked(`flood_${index}`))
  const flood = requests().filter(item => item.native?.requestId.startsWith("flood_"))
  assert.equal(flood.length, 256, "one conversation shows at most 256 pending native requests")

  await interactions.close()
  const closed = emitted.filter(item => item.type === "live-permission-ended" && item.source === "connection-close")
  assert.equal(closed.length, 256, "requests pending at shutdown end with the connection")

  // Retention failure never keeps a resolved request open.
  const blocked = join(store, "blocked")
  await writeFile(blocked, "")
  const unretained: LiveDriverEvent[] = []
  const failing = new OpenCodeInteractions({ client, root: join(blocked, "evidence"), conversationId: "conversation", owns: () => true, emit: item => { unretained.push(item) } })
  await failing.observe(asked("per_9"))
  await failing.observe(event("permission.replied", { sessionID: root, requestID: "per_9", reply: "reject" }))
  assert.ok(unretained.some(item => item.type === "live-permission-ended" && item.source === "native-resolution"))
  assert.ok(!unretained.some(item => item.type === "live-approval-decision"))
  await failing.close().catch(() => {})
} finally {
  await rm(store, { recursive: true, force: true })
}

// Model requests.
{
  const { models } = normalizeOpenCodeModels([
    { id: "sonnet", providerID: "anthropic", name: "Sonnet", variants: { low: {}, high: {} }, limit: { context: 200000 } },
    { id: "free", providerID: "opencode", name: "Free", limit: { context: 100000 } },
  ])
  const catalog = { models }
  const fallback = { providerID: "opencode", id: "free" }
  assert.deepEqual(openCodeRequestedModel(catalog, undefined, fallback), fallback)
  assert.deepEqual(openCodeRequestedModel(catalog, { model: "anthropic/sonnet", options: { effort: "high" } }, fallback), { providerID: "anthropic", id: "sonnet", variant: "high" })
  assert.deepEqual(openCodeRequestedModel(catalog, { model: "anthropic/sonnet", options: { effort: "default" } }, fallback), { providerID: "anthropic", id: "sonnet" },
    "OpenCode's default variant is its unnamed configuration")
  assert.deepEqual(openCodeRequestedModel(catalog, { model: "opencode/new-model", options: { effort: "max" } }, fallback), { providerID: "opencode", id: "new-model", variant: "max" },
    "a model the startup snapshot lacks is OpenCode's to resolve")
  const current = { providerID: "gone", id: "model", variant: "high" }
  assert.deepEqual(openCodeRequestedModel(catalog, undefined, current), current, "an unlisted running model is kept with its variant")
  assert.deepEqual(openCodeRequestedModel(catalog, { options: { effort: "low" } }, current), { providerID: "gone", id: "model", variant: "low" })
  assert.throws(() => openCodeRequestedModel(catalog, { model: "no-provider" }, fallback), /provider\/model/)
  assert.throws(() => openCodeRequestedModel(catalog, undefined, undefined), /no default model/)
}

// Client-chosen inbox IDs sort in send order, as OpenCode's own do.
{
  const ids = Array.from({ length: 50 }, () => openCodeMessageId())
  for (const id of ids) assert.match(id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.deepEqual([...ids].sort(), ids)
  assert.equal(new Set(ids).size, ids.length)
}

// Markers the driver reads off events that are not content.
{
  const mcp = new OpenCodeMcpHealth()
  const server = (name: string, status: McpServer["status"]): McpServer => ({ name, status })
  assert.deepEqual(mcp.observe([server("docs", { status: "failed", error: "spawn docs-mcp ENOENT" }), server("ok", { status: "connected" })]),
    [{ label: "MCP server failed", detail: "docs · spawn docs-mcp ENOENT", tone: "warning" }])
  assert.deepEqual(mcp.observe([server("docs", { status: "failed", error: "spawn docs-mcp ENOENT again" })]), [], "a server that keeps failing is one marker")
  assert.deepEqual(mcp.observe([server("docs", { status: "pending" })]), [])
  assert.deepEqual(mcp.observe([server("docs", { status: "failed", error: "still" })]), [], "a retry that fails again is the same failure")
  assert.deepEqual(mcp.observe([server("docs", { status: "connected" }), server("drive", { status: "needs_auth" })]),
    [{ label: "MCP server failed", detail: "drive · needs sign-in", tone: "warning" }])
  assert.equal(mcp.observe([server("docs", { status: "failed", error: "crashed" })]).length, 1, "failing again after recovering is a new marker")
  const [refused] = mcp.failed("big", `Invalid config\n${"x".repeat(300)}`)
  assert.deepEqual(refused, { label: "MCP server failed", detail: "big · Invalid config", body: `Invalid config\n${"x".repeat(300)}`, tone: "warning" },
    "a long error stays one line beside the label, whole in the body")
  assert.equal(openCodeStopped("user"), undefined, "a turn the user stopped needs no marker")
  assert.deepEqual(openCodeStopped("superseded"), { label: "Stopped by OpenCode", detail: "a newer run took its place" })
  assert.ok(openCodeIgnores(event("tui.toast.show", { message: "hi", variant: "warning" })))
  assert.ok(openCodeIgnores(event("rpc.internal", {})))
  assert.ok(!openCodeIgnores(event("mcp.status.changed", { server: "docs" })))
}

// The live driver against a fake OpenCode: an executable that reports its
// version and health, every other request answered here at the driver's
// fetch boundary, and a native event stream the test writes.
{
  const home = await mkdtemp(join(tmpdir(), "mako-opencode-driver-"))
  const log = join(home, "host.log")
  installHostLog(log)
  const executable = join(home, "opencode.mjs")
  await writeFile(executable, `#!${process.execPath}
import { createServer } from "node:http"
if (process.argv.includes("--version")) { console.log("2.0.1"); process.exit(0) }
const server = createServer((_request, response) => {
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify({ healthy: true, version: "2.0.1", pid: process.pid }))
})
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ url: "http://127.0.0.1:" + server.address().port })))
process.stdin.resume()
process.stdin.on("end", () => process.exit(0))
`, { mode: 0o700 })
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_BIN_PATH: executable, HOME: home, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config") }
  const encoder = new TextEncoder()
  let push: (native: OpenCodeEvent) => void = () => {}
  let mcpServers: McpServer[] = []
  let compactID: string | undefined
  const unexpected: string[] = []
  const reply = (data: JsonValue | McpServer[]) => new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } })
  const driver = createOpenCodeDriver({
    env: async () => ({ ...env }),
    approvalRoot: async () => join(home, "approvals"),
    fetch: async (input, init) => {
      const { pathname } = new URL(String(input))
      switch (pathname) {
        case "/api/health": return fetch(input, init)
        case "/api/event":
          return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            push = native => controller.enqueue(encoder.encode(`data: ${JSON.stringify(native)}\n\n`))
            push(event("server.connected", {}))
          } }), { headers: { "content-type": "text/event-stream" } })
        case "/api/plugin/await-activation": return new Response(null, { status: 204 })
        case "/api/model": return reply([{ id: "m", providerID: "p", name: "M", family: "m", enabled: true, status: "active", variants: [],
          limit: { context: 200_000, output: 8_000 }, capabilities: { input: ["text"] } }])
        case "/api/model/default": return reply({ id: "m", providerID: "p" })
        case "/api/agent": return reply([{ id: "build", name: "build", mode: "primary" }])
        case "/api/command": case "/api/skill": case "/api/shell": return reply([])
        case "/api/session": return reply({ id: root, title: "Fixture" })
        case "/api/mcp": return reply(mcpServers)
        case `/api/session/${root}/compact`:
          compactID = z.object({ id: z.string() }).parse(JSON.parse(String(init?.body))).id
          return reply({ id: compactID })
        default:
          unexpected.push(pathname)
          return new Response(null, { status: 404 })
      }
    },
  })
  const emitted: LiveDriverEvent[] = []
  const id = "conversation-driver"
  const until = async <T>(label: string, probe: () => T | undefined | false): Promise<T> => {
    const deadline = Date.now() + 5000
    for (;;) {
      const value = probe()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}; saw ${JSON.stringify(emitted.slice(-6))}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const markers = () => emitted.flatMap(item => item.type === "live-update" && item.update.kind === "event" ? [item.update] : [])
  const activities = () => emitted.flatMap(item => item.type === "live-activity" ? [item.activity] : [])
  const session = () => emitted.flatMap(item => item.type === "live-session" ? [item.session] : []).at(-1)
  try {
    const started = await driver.start(home, { conversationId: id, emit: item => { emitted.push(item) } })
    assert.equal(started.status, "ready", started.error)
    const assistantMessageID = "msg_a"
    push(event("session.execution.started", { sessionID: root }))
    await until("the turn OpenCode starts", () => session()?.status === "running")

    const retryAt = Date.now() + 30_000
    push(event("session.retry.scheduled", { sessionID: root, assistantMessageID, attempt: 2, at: retryAt, error: { type: "provider.rate-limit", message: "Too many requests" } }))
    assert.deepEqual(await until("the retry", () => activities().find(activity => activity?.kind === "retrying")),
      { kind: "retrying", attempt: 2, reason: "Too many requests", retryAt }, "the countdown runs to OpenCode's next attempt")

    push(event("session.step.ended", { sessionID: root, assistantMessageID, finish: "stop", cost: 0, tokens: { input: 150_000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } } }))
    push(event("session.compaction.started", { sessionID: root, reason: "auto", recent: "" }))
    push(event("session.compaction.delta", { sessionID: root, text: "Sum" }))
    const compacted = event("session.compaction.ended", { sessionID: root, reason: "auto", text: "Summary of the work so far.", recent: "" })
    push(compacted)
    push(compacted)
    assert.deepEqual(await until("the compaction", () => markers().find(marker => marker.label === "Context compacted")),
      { kind: "event", id: compacted.id, label: "Context compacted", detail: "Automatic · from 151k tokens", body: "Summary of the work so far." })

    push(event("session.compaction.started", { sessionID: root, reason: "auto", recent: "" }))
    const failed = event("session.compaction.failed", { sessionID: root, reason: "auto", error: { type: "compaction.failed", message: "The model could not summarize" } })
    push(failed)
    assert.deepEqual(await until("the failed compaction", () => markers().find(marker => marker.label === "Compaction failed")),
      { kind: "event", id: failed.id, label: "Compaction failed", detail: "The model could not summarize", tone: "warning" }, "an automatic compaction that fails leaves its trace")
    assert.equal(activities().at(-1), null, "compacting ends with the failure")
    assert.equal(markers().filter(marker => marker.label === "Context compacted").length, 1, "OpenCode's event replayed is drawn once")

    const interrupted = event("session.execution.interrupted", { sessionID: root, reason: "inactivity" })
    push(interrupted)
    assert.deepEqual(await until("OpenCode's stop", () => markers().find(marker => marker.label === "Stopped by OpenCode")),
      { kind: "event", id: interrupted.id, label: "Stopped by OpenCode", detail: "the workspace was idle too long" })
    await until("the stopped turn to settle", () => session()?.status === "ready")

    mcpServers = [{ name: "docs", status: { status: "failed", error: "spawn docs-mcp ENOENT" } }]
    push(event("mcp.status.changed", { server: "docs" }))
    push(event("mcp.status.changed", { server: "docs" }))
    assert.deepEqual(await until("the MCP failure", () => markers().find(marker => marker.label === "MCP server failed")),
      { kind: "event", label: "MCP server failed", detail: "docs · spawn docs-mcp ENOENT", tone: "warning" })

    if (driver.compaction?.kind !== "supported") throw new Error("OpenCode compaction is supported")
    const actionId = randomUUID()
    await driver.compaction.start(id, actionId)
    push(event("session.compaction.failed", { sessionID: root, reason: "manual", inputID: compactID, error: { type: "compaction.failed", message: "Nothing to compact" } }))
    const result = await until("the compaction action", () => emitted.find(item => item.type === "live-action-result" && item.actionId === actionId))
    assert.deepEqual(result.type === "live-action-result" && result.result, { kind: "failed", reason: "Nothing to compact" })

    const quiet: Array<[string, EventData]> = [
      ["tui.toast.show", { message: "MCP Authentication Required", variant: "warning" }],
      ["config.updated", {}],
      ["installation.update-available", { version: "2.0.2" }],
      ["session.synthetic", { sessionID: root, text: "notice" }],
      ["session.skill.activated", { sessionID: root, id: "s", name: "review", text: "" }],
      ["session.revert.committed", { sessionID: root, to: "msg_x" }],
      ["future.sessionless", {}],
      ["session.future.scoped", { sessionID: root }],
    ]
    for (const [type, data] of quiet) push(event(type, data))
    push(event("session.renamed", { sessionID: root, title: "Settled" }))
    await until("the stream to drain", () => session()?.title === "Settled")

    assert.equal(markers().filter(marker => marker.label === "MCP server failed").length, 1, "a server's repeated status is one marker")
    assert.equal(markers().filter(marker => marker.label === "Compaction failed").length, 1, "a compaction Mako asked for fails its action, not a second marker")
    assert.deepEqual(unexpected, [])
    await flushHostLog()
    const unhandled = (await readFile(log, "utf8")).split("\n").filter(line => line.includes("native event not handled") && line.includes("harness=opencode"))
      .map(line => /kind=(\S+)/.exec(line)?.[1])
    assert.deepEqual(unhandled, ["future.sessionless", "session.future.scoped"],
      "unknown events are logged once each; handled, ignored and sessionless-but-known events are not")
  } finally {
    await driver.close(id)
    await rm(home, { recursive: true, force: true })
  }
}

console.log("OpenCode projection: session-scoped rows, child labels, diffs, plans, answered question rows, missed-start naming, settling, bounded calls; native permission/form wire, one-shot answers, gap reconciliation, bounded requests, shutdown and retention failure; model pass-through; ordered inbox ids; retry countdown, compaction summary and failure, OpenCode's own stops, MCP failures once, explicit ignores and unknown-event logging")

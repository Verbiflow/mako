import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { normalizeOpenCodeModels } from "@mako/sessions/model-catalog"
import { OpenCodeContent } from "../electron/providers/opencode/content.ts"
import { OpenCodeInteractions } from "../electron/providers/opencode/interactions.ts"
import { openCodeRequestedModel } from "../electron/providers/opencode/catalog.ts"
import { openCodeMessageId } from "../electron/providers/opencode/live-driver.ts"
import type { LiveDriverEvent, LiveUpdate } from "../electron/shared.ts"
import type { ApprovalSubmission } from "../electron/contracts/approval-response.ts"

const event = (type: string, data: Record<string, unknown>) => ({ id: randomUUID(), created: Date.now(), type, data }) as unknown as OpenCodeEvent
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

  content.observe(event("session.tool.input.started", { sessionID: root, assistantMessageID: message, id: "w", name: "write" }))
  const [write] = content.observe(event("session.tool.called", { sessionID: root, assistantMessageID: message, id: "w", input: { filePath: "/abs/new.txt", content: "fresh" }, executed: false }))
  assert.deepEqual(write.kind === "tool-update" && write.details, [{ type: "location", path: "/abs/new.txt" }, { type: "diff", path: "/abs/new.txt", oldText: null, newText: "fresh" }])
  content.observe(event("session.tool.input.started", { sessionID: root, assistantMessageID: message, id: "e", name: "edit" }))
  const [edit] = content.observe(event("session.tool.called", { sessionID: root, assistantMessageID: message, id: "e", input: { filePath: "b.txt", oldString: "a", newString: "b" }, executed: false }))
  assert.deepEqual(edit.kind === "tool-update" && edit.details?.[1], { type: "diff", path: "/work/b.txt", oldText: "a", newText: "b" })
  content.observe(event("session.tool.input.started", { sessionID: root, assistantMessageID: message, id: "todo", name: "todowrite" }))
  const todo = content.observe(event("session.tool.called", { sessionID: root, assistantMessageID: message, id: "todo", input: { todos: [{ content: "Ship it", status: "pending" }] }, executed: false }))
  assert.deepEqual(todo.find(update => update.kind === "plan"), { kind: "plan", entries: [{ content: "Ship it", status: "pending" }] })

  assert.deepEqual(content.observe(event("session.tool.input.started", { sessionID: root, assistantMessageID: message, id: "q", name: "question" })), [])
  assert.deepEqual(content.observe(event("session.tool.called", { sessionID: root, assistantMessageID: message, id: "q", input: {}, executed: false })), [],
    "the question tool is the form, never a row")

  const [failed] = content.observe(event("session.tool.failed", { sessionID: root, assistantMessageID: message, id: "e", error: { type: "tool", message: "no match" }, content: [{ type: "text", text: "detail" }] }))
  assert.equal(failed.kind === "tool-update" && failed.status, "failed")
  assert.equal(failed.kind === "tool-update" && failed.output, "no match\ndetail")

  // A resubscribed stream first sees a call at its result; the driver opens it under its native name.
  assert.deepEqual(content.open(root, "late", "grep"), [{ kind: "tool", id: `${root}:late`, title: "grep", toolKind: "grep", status: "pending" }])
  assert.deepEqual(content.open(root, "late", "grep"), [], "opening is idempotent")
  const [lateCalled] = content.observe(event("session.tool.called", { sessionID: root, assistantMessageID: message, id: "late", input: { pattern: "TODO" }, executed: false }))
  assert.equal(lateCalled.kind === "tool-update" && lateCalled.title, "TODO")
  assert.deepEqual(content.open(root, "late-question", "question"), [])
  assert.deepEqual(content.observe(event("session.tool.success", { sessionID: root, assistantMessageID: message, id: "late-question", content: [] })), [])

  const settled = content.settle(root, "cancelled", "Stopped before this call finished.")
  assert.deepEqual(new Set(settled.map(update => update.id)), new Set([`${root}:w`, `${root}:todo`, `${root}:late`]),
    "settling ends the session's open rows and never the hidden question")
  assert.ok(settled.every(update => update.kind === "tool-update" && update.status === "cancelled"))
  assert.equal(content.name(child, "t1"), "read", "settling one session leaves another's calls open")

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
  const formStates = new Map<string, unknown>()
  const client = {
    permission: {
      reply: async (input: unknown) => { calls.push(["permission.reply", input]) },
      list: async () => openPermissions,
    },
    form: {
      reply: async (input: { formID: string; answer: unknown }) => { calls.push(["form.reply", input]); formStates.set(input.formID, { status: "answered", answer: input.answer }) },
      cancel: async (input: { formID: string }) => { calls.push(["form.cancel", input]); formStates.set(input.formID, { status: "cancelled" }) },
      list: async () => [],
      state: async (input: { formID: string }) => formStates.get(input.formID) ?? { status: "pending" },
    },
  } as unknown as OpenCodeClient
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
  const asked = (id: string, sessionID = root, extra: Record<string, unknown> = {}) => event("permission.asked", {
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

console.log("OpenCode projection: session-scoped rows, child labels, diffs, plans, hidden question tool, missed-start naming, settling, bounded calls; native permission/form wire, one-shot answers, gap reconciliation, bounded requests, shutdown and retention failure; model pass-through; ordered inbox ids")

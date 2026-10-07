import { z } from "zod"
import { attachmentFromUrl, type AttachmentContent, type ToolDetail } from "./content.js"
import { clip } from "./format.js"
import type { LiveUpdate } from "./live-content.js"
import { openCodePlan } from "./providers/opencode-plan.js"
import { OpenCodeEditInput, openCodeFailedExit, openCodeFileName, openCodeToolDetails } from "./providers/opencode-tools.js"
import { normalizeToolOutput } from "./tool-output.js"

const JsonSchema = z.json()
type JsonValue = z.infer<typeof JsonSchema>

const Todo = z.object({ todos: z.array(z.object({ content: z.string(), status: z.string() })) })
const Titled = z.object({ command: z.string().optional(), path: z.string().optional(), filePath: z.string().optional(), pattern: z.string().optional(), url: z.string().optional(), query: z.string().optional(), description: z.string().optional(),
  questions: z.array(z.object({ question: z.string() })).optional() })
const MAX_OPEN_TOOLS = 4096
const MAX_OPEN_STEPS = 64

/** A tool result's parts, as OpenCode 2.0 streams them and keeps them in `session_message`. */
export type OpenCodeToolContent =
  | { type: "text"; text: string }
  | { type: "file"; name?: string; mime: string; uri: string }

/** How a call ended: its result, or the error that ended it (`aborted` when stopped). */
export interface OpenCodeToolEnd {
  content?: readonly OpenCodeToolContent[]
  metadata?: JsonValue
  error?: { type: string; message: string }
}

interface Tool { sessionID: string; name: string; title: string; input: JsonValue | undefined }
interface Step { agent: string; texts: Map<number, string> }

/** Native names become the transcript's shared vocabulary; unknown names stay themselves. */
export function openCodeToolKind(name: string): string {
  switch (name) {
    case "shell": case "bash": return "execute"
    case "edit": case "patch": case "apply_patch": case "multiedit": return "edit"
    case "write": return "write"
    case "read": return "read"
    default: return name
  }
}

function toolTitle(name: string, input: JsonValue | undefined): string {
  const value = Titled.safeParse(input)
  if (!value.success) return name
  const { command, path, filePath, pattern, url, query, description, questions } = value.data
  switch (name) {
    case "shell": case "bash": return command ?? name
    case "read": case "edit": case "write": case "patch": case "multiedit": return path ?? filePath ?? name
    case "grep": case "glob": return pattern ?? name
    case "webfetch": return url ?? name
    case "websearch": return query ?? name
    case "subagent": case "task": return description ?? name
    case "question": return questions?.[0]?.question ?? name
    default: return name
  }
}

/**
 * One OpenCode conversation as live transcript updates, from its stream
 * (electron's `openCodeEventUpdates`) or from the messages its store keeps
 * (`OpenCodeProvider`), so both draw it the same way. Tool IDs are session
 * scoped, so a child's call never overwrites its parent's. Child sessions
 * contribute tool rows under their own title; their prose stays in their own
 * native session.
 */
export class OpenCodeContent {
  private readonly tools = new Map<string, Tool>()
  private readonly titles = new Map<string, string>()
  /** The root's running steps: the agent of each, and its finished text parts by ordinal. */
  private readonly steps = new Map<string, Step>()
  private readonly root: string
  private readonly cwd: string
  constructor(root: string, cwd: string) {
    this.root = root
    this.cwd = cwd
  }

  /** Child session titles, from `session.created`, prefix that child's tool rows. */
  nameSession(sessionID: string, title: string | undefined): void {
    if (sessionID !== this.root && title) this.titles.set(sessionID, title)
  }

  /** The row title for a native tool call, when it is still open. */
  title(sessionID: string, toolID: string): string | undefined {
    return this.tools.get(`${sessionID}:${toolID}`)?.title
  }

  /** The native tool name of an open call. */
  name(sessionID: string, toolID: string): string | undefined {
    return this.tools.get(`${sessionID}:${toolID}`)?.name
  }

  /** What a child session's rows and requests are prefixed with. */
  prefix(sessionID: string): string {
    return sessionID === this.root ? "" : `${this.titles.get(sessionID) ?? "Subagent"}: `
  }

  text(sessionID: string, messageID: string, ordinal: number, delta: string): LiveUpdate[] {
    return sessionID === this.root ? [{ kind: "text", id: `${messageID}:${ordinal}`, text: delta }] : []
  }

  reasoning(sessionID: string, messageID: string, ordinal: number, delta: string): LiveUpdate[] {
    return sessionID === this.root ? [{ kind: "thinking", id: `${messageID}:reasoning:${ordinal}`, text: delta }] : []
  }

  stepStarted(sessionID: string, messageID: string, agent: string): void {
    if (sessionID !== this.root) return
    if (this.steps.size >= MAX_OPEN_STEPS) this.steps.delete(this.steps.keys().next().value!)
    this.steps.set(messageID, { agent, texts: new Map() })
  }

  textEnded(sessionID: string, messageID: string, ordinal: number, text: string): void {
    if (sessionID === this.root) this.steps.get(messageID)?.texts.set(ordinal, text)
  }

  /** A Plan step that ends the turn folds its streamed reply into the plan card (`openCodePlan`). */
  stepEnded(sessionID: string, messageID: string, finish: string | undefined): LiveUpdate[] {
    const step = sessionID === this.root ? this.steps.get(messageID) : undefined
    this.steps.delete(messageID)
    if (!step) return []
    const ordinals = [...step.texts.keys()].sort((a, b) => a - b)
    const plan = openCodePlan(messageID, step.agent, finish, ordinals.map((ordinal) => step.texts.get(ordinal)!))
    if (!plan) return []
    return [
      { kind: "retract", ids: ordinals.map((ordinal) => `${messageID}:${ordinal}`) },
      { kind: "proposed-plan", id: plan.id, text: plan.text, status: "proposed", replace: true },
    ]
  }

  /** The model began a call; its input is still streaming. */
  toolStarted(sessionID: string, toolID: string, name: string): LiveUpdate[] {
    return this.open(sessionID, toolID, name)
  }

  toolCalled(sessionID: string, toolID: string, input: JsonValue | undefined): LiveUpdate[] {
    const id = `${sessionID}:${toolID}`
    const updates = this.open(sessionID, toolID, "tool")
    const tool = this.tools.get(id)!
    tool.input = input
    tool.title = toolTitle(tool.name, input)
    updates.push({ kind: "tool-update", id, title: `${this.prefix(sessionID)}${tool.title}`, status: "in_progress",
      input: JSON.stringify(input, null, 2), details: this.details(tool) })
    if (tool.name === "todowrite") {
      const todo = Todo.safeParse(input)
      if (todo.success) updates.push({ kind: "plan", entries: todo.data.todos })
    }
    return updates
  }

  toolEnded(sessionID: string, toolID: string, end: OpenCodeToolEnd): LiveUpdate[] {
    const id = `${sessionID}:${toolID}`
    const updates = this.open(sessionID, toolID, "tool")
    this.tools.delete(id)
    const content = end.content ?? []
    const text = content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
    const output = end.error ? [end.error.message, text].filter(Boolean).join("\n") : text
    const attachments: AttachmentContent[] = content.flatMap(part =>
      part.type === "file" ? [attachmentFromUrl(openCodeFileName(part.name), part.mime, part.uri)] : [])
    const status = end.error
      ? end.error.type === "aborted" ? "cancelled" : "failed"
      : openCodeFailedExit(end.metadata) ? "failed" : "completed"
    updates.push({ kind: "tool-update", id, status,
      output: clip(normalizeToolOutput(output)), attachments: attachments.length ? attachments : undefined })
    return updates
  }

  /** Rows a session left open when its execution stopped without finishing them. */
  settle(sessionID: string, status: "cancelled" | "failed", note: string): LiveUpdate[] {
    const updates: LiveUpdate[] = []
    for (const [id, tool] of this.tools) {
      if (tool.sessionID !== sessionID) continue
      this.tools.delete(id)
      const update: LiveUpdate = { kind: "tool-update", id, status, output: note }
      if (status === "failed") update.unfinished = true
      updates.push(update)
    }
    return updates
  }

  /**
   * Open a call whose start was missed (a resubscribed stream), under the
   * name its native message records.
   */
  open(sessionID: string, toolID: string, name: string): LiveUpdate[] {
    const id = `${sessionID}:${toolID}`
    if (this.tools.has(id)) return []
    if (this.tools.size >= MAX_OPEN_TOOLS) this.tools.delete(this.tools.keys().next().value!)
    this.tools.set(id, { sessionID, name, title: name, input: {} })
    return [{ kind: "tool", id, title: `${this.prefix(sessionID)}${name}`, name, toolKind: openCodeToolKind(name), status: "pending" }]
  }

  private details(tool: Tool): ToolDetail[] | undefined {
    return openCodeToolDetails(tool.name, OpenCodeEditInput.safeParse(tool.input).data, this.cwd)
  }
}

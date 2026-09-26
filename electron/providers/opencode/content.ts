import type { OpenCodeEvent } from "@opencode/client"
import { clip, normalizeToolOutput } from "@mako/sessions"
import { attachmentFromUrl, type AttachmentContent, type ToolDetail } from "@mako/sessions/content"
import { isAbsolute, join } from "node:path"
import { z } from "zod"
import type { LiveUpdate } from "../../shared.js"

const Edit = z.object({ path: z.string().optional(), filePath: z.string().optional(), oldString: z.string().optional(), newString: z.string().optional(), content: z.string().optional() })
const Todo = z.object({ todos: z.array(z.object({ content: z.string(), status: z.string() })) })
const Titled = z.object({ command: z.string().optional(), path: z.string().optional(), filePath: z.string().optional(), pattern: z.string().optional(), url: z.string().optional(), query: z.string().optional(), description: z.string().optional(),
  questions: z.array(z.object({ question: z.string() })).optional() })
const MAX_OPEN_TOOLS = 4096

interface Tool { sessionID: string; name: string; title: string; input: Record<string, unknown> }
type ToolEvent = Extract<OpenCodeEvent, { type: `session.tool.${string}` }>

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

function toolTitle(name: string, input: Record<string, unknown>): string {
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
 * One conversation's native stream, reduced to live transcript updates.
 * Tool IDs are session scoped, so a child's call never overwrites its parent's.
 * Child sessions contribute tool rows under their own title; their prose stays
 * in their own native session.
 */
export class OpenCodeContent {
  private readonly tools = new Map<string, Tool>()
  private readonly titles = new Map<string, string>()
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

  observe(event: OpenCodeEvent): LiveUpdate[] {
    switch (event.type) {
      case "session.text.delta":
        return event.data.sessionID === this.root
          ? [{ kind: "text", id: `${event.data.assistantMessageID}:${event.data.ordinal}`, text: event.data.delta }] : []
      case "session.reasoning.delta":
        return event.data.sessionID === this.root
          ? [{ kind: "thinking", id: `${event.data.assistantMessageID}:reasoning:${event.data.ordinal}`, text: event.data.delta }] : []
      case "session.tool.input.started":
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed":
        return this.tool(event)
      default:
        return []
    }
  }

  /** Rows a session left open when its execution stopped without finishing them. */
  settle(sessionID: string, status: "cancelled" | "failed", note: string): LiveUpdate[] {
    const updates: LiveUpdate[] = []
    for (const [id, tool] of this.tools) {
      if (tool.sessionID !== sessionID) continue
      this.tools.delete(id)
      updates.push({ kind: "tool-update", id, status, output: note })
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
    return this.start(sessionID, id, name)
  }

  private start(sessionID: string, id: string, name: string): LiveUpdate[] {
    if (this.tools.size >= MAX_OPEN_TOOLS) this.tools.delete(this.tools.keys().next().value!)
    this.tools.set(id, { sessionID, name, title: name, input: {} })
    return [{ kind: "tool", id, title: `${this.prefix(sessionID)}${name}`, toolKind: openCodeToolKind(name), status: "pending" }]
  }

  private tool(event: Extract<ToolEvent, { type: "session.tool.input.started" | "session.tool.called" | "session.tool.progress" | "session.tool.success" | "session.tool.failed" }>): LiveUpdate[] {
    const { sessionID } = event.data
    const id = `${sessionID}:${event.data.id}`
    const prefix = this.prefix(sessionID)
    const updates: LiveUpdate[] = []
    if (!this.tools.has(id)) {
      if (event.type === "session.tool.progress") return []
      updates.push(...this.start(sessionID, id, event.type === "session.tool.input.started" ? event.data.name : "tool"))
    }
    const tool = this.tools.get(id)!
    switch (event.type) {
      case "session.tool.input.started":
        return updates
      case "session.tool.called": {
        tool.input = event.data.input
        tool.title = toolTitle(tool.name, tool.input)
        updates.push({ kind: "tool-update", id, title: `${prefix}${tool.title}`, status: "in_progress",
          input: JSON.stringify(tool.input, null, 2), details: this.details(tool) })
        if (tool.name === "todowrite") {
          const todo = Todo.safeParse(tool.input)
          if (todo.success) updates.push({ kind: "plan", entries: todo.data.todos })
        }
        return updates
      }
      case "session.tool.progress":
        return updates
      case "session.tool.success":
      case "session.tool.failed": {
        this.tools.delete(id)
        const content = event.data.content ?? []
        const text = content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
        const output = event.type === "session.tool.failed"
          ? [event.data.error.message, text].filter(Boolean).join("\n")
          : text
        const attachments: AttachmentContent[] = content.flatMap(part =>
          part.type === "file" ? [attachmentFromUrl(part.name ?? "Attachment", part.mime, part.uri)] : [])
        const status = event.type === "session.tool.success" ? "completed" : event.data.error.type === "aborted" ? "cancelled" : "failed"
        updates.push({ kind: "tool-update", id, status,
          output: clip(normalizeToolOutput(output)), attachments: attachments.length ? attachments : undefined })
        return updates
      }
    }
  }

  private details(tool: Tool): ToolDetail[] | undefined {
    const edit = Edit.safeParse(tool.input)
    if (!edit.success) return undefined
    const relative = edit.data.path ?? edit.data.filePath
    if (!relative) return undefined
    const path = isAbsolute(relative) ? relative : join(this.cwd, relative)
    const details: ToolDetail[] = [{ type: "location", path }]
    if (tool.name === "write" && edit.data.content !== undefined)
      details.push({ type: "diff", path, oldText: null, newText: edit.data.content })
    else if (edit.data.oldString !== undefined && edit.data.newString !== undefined)
      details.push({ type: "diff", path, oldText: edit.data.oldString, newText: edit.data.newString })
    return details
  }
}

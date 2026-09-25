import type { OpenCodeEvent } from "@opencode/client"
import { attachmentFromUrl, type ToolDetail } from "@mako/sessions/content"
import type { LiveUpdate } from "../../shared.js"
import { z } from "zod"

const Edit = z.object({ filePath: z.string(), oldString: z.string().optional(), newString: z.string().optional(), content: z.string().optional() })
const Todo = z.object({ todos: z.array(z.object({ content: z.string(), status: z.string() })) })
interface Tool { name: string; input: Record<string, unknown> }

/** Native tool IDs are session scoped; child tools must never overwrite a parent. */
export class OpenCodeContent {
  private readonly tools = new Map<string, Tool>()
  constructor(private readonly root: string) {}
  observe(event: OpenCodeEvent): LiveUpdate[] {
    if (!('sessionID' in event.data) || typeof event.data.sessionID !== "string") return []
    const child = event.data.sessionID !== this.root
    if (event.type === "session.text.delta") return child ? [] : [{ kind: "text", id: event.data.assistantMessageID, text: event.data.delta }]
    if (event.type === "session.reasoning.delta") return child ? [] : [{ kind: "thinking", id: `${event.data.assistantMessageID}:${event.data.ordinal}`, text: event.data.delta }]
    if (!event.type.startsWith("session.tool.") || !('id' in event.data) || typeof event.data.id !== "string") return []
    const id = `${event.data.sessionID}:${event.data.id}`
    if (event.type === "session.tool.input.started") {
      if (this.tools.size >= 4096) throw new Error("OpenCode pending tool capacity reached")
      this.tools.set(id, { name: event.data.name, input: {} })
      return event.data.name === "question" ? [] : [{ kind: "tool", id, title: child ? `Subagent · ${event.data.name}` : event.data.name, toolKind: event.data.name, status: "pending" }]
    }
    const tool = this.tools.get(id)
    if (!tool) return []
    if (event.type === "session.tool.called") {
      tool.input = event.data.input
      if (tool.name === "question") return []
      const edit = Edit.safeParse(tool.input)
      const details: ToolDetail[] = []
      if (edit.success) {
        const value = edit.data
        details.push({ type: "location", path: value.filePath })
        if (value.newString !== undefined || value.content !== undefined) details.push({ type: "diff", path: value.filePath, oldText: value.oldString ?? null, newText: value.newString ?? value.content ?? "" })
      }
      const updates: LiveUpdate[] = [{ kind: "tool-update", id, status: "in_progress", input: JSON.stringify(tool.input, null, 2), details }]
      if (tool.name === "todowrite") {
        const todo = Todo.safeParse(tool.input)
        if (todo.success) updates.push({ kind: "plan", entries: todo.data.todos })
      }
      return updates
    }
    if (event.type !== "session.tool.success" && event.type !== "session.tool.failed") return []
    this.tools.delete(id)
    if (tool.name === "question") return []
    const content = event.data.content ?? []
    return [{ kind: "tool-update", id, status: event.type === "session.tool.success" ? "completed" : "failed",
      output: event.type === "session.tool.failed" ? event.data.error.message : content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"),
      attachments: content.flatMap(part => part.type === "file" ? [attachmentFromUrl(part.name ?? "Attachment", part.mime, part.uri)] : []),
    }]
  }
}

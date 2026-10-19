import type { OpenCodeEvent } from "@opencode/client"
import type { OpenCodeContent } from "@mako/sessions/opencode-content"
import type { LiveUpdate } from "@mako/sessions/live-content"

type CallEvent = Extract<OpenCodeEvent, { type: "session.tool.called" | "session.tool.success" | "session.tool.failed" }>

/** One stream event through the conversation's projection; `unknown` hears an event it does not know. */
export function openCodeEventUpdates(content: OpenCodeContent, event: OpenCodeEvent, unknown?: (type: string) => void): LiveUpdate[] {
  switch (event.type) {
    case "session.text.delta":
      content.carry(event.data.sessionID, event.data.assistantMessageID)
      return content.text(event.data.sessionID, event.data.assistantMessageID, event.data.ordinal, event.data.delta)
    case "session.reasoning.delta":
      content.carry(event.data.sessionID, event.data.assistantMessageID)
      return content.reasoning(event.data.sessionID, event.data.assistantMessageID, event.data.ordinal, event.data.delta)
    case "session.tool.input.started":
      content.carry(event.data.sessionID, event.data.assistantMessageID)
      return content.toolStarted(event.data.sessionID, event.data.id, event.data.name)
    case "session.tool.called":
      return [...missedCall(content, event), ...content.toolCalled(event.data.sessionID, event.data.id, event.data.input)]
    case "session.tool.success":
      return [...missedCall(content, event), ...content.toolEnded(event.data.sessionID, event.data.id, { content: event.data.content, metadata: event.data.metadata })]
    case "session.tool.failed":
      return [...missedCall(content, event), ...content.toolEnded(event.data.sessionID, event.data.id, { content: event.data.content, error: event.data.error })]
    case "session.step.started":
      content.carry(event.data.sessionID, event.data.assistantMessageID)
      content.stepStarted(event.data.sessionID, event.data.assistantMessageID, event.data.agent)
      return []
    case "session.text.ended":
      content.textEnded(event.data.sessionID, event.data.assistantMessageID, event.data.ordinal, event.data.text)
      return []
    case "session.step.ended":
      return content.stepEnded(event.data.sessionID, event.data.assistantMessageID, event.data.finish)
    case "session.text.started":
    case "session.reasoning.started":
      content.carry(event.data.sessionID, event.data.assistantMessageID)
      return []
    // Their content arrives as the deltas and tool results above; a call's progress has nothing to draw.
    case "session.tool.progress":
    case "session.reasoning.ended":
    case "session.tool.input.delta":
    case "session.tool.input.ended":
    case "session.step.streamed":
    case "session.step.failed":
    case "session.status":
    case "session.idle":
      return []
    default:
      unknown?.(event.type)
      return []
  }
}

/**
 * A call first seen after its start: in a reply this stream carried, its
 * start fell in a gap and it opens here; in one it never carried, it is an
 * earlier launch's call, whose row that launch drew, and opens nothing.
 */
function missedCall(content: OpenCodeContent, event: CallEvent): LiveUpdate[] {
  const { sessionID, assistantMessageID, id } = event.data
  if (content.name(sessionID, id) !== undefined || !content.carries(sessionID, assistantMessageID)) return []
  return content.open(sessionID, id, "tool")
}

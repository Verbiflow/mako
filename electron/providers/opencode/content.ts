import type { OpenCodeEvent } from "@opencode/client"
import type { OpenCodeContent } from "@mako/sessions/opencode-content"
import type { LiveUpdate } from "../../shared.js"

/** One stream event through the conversation's projection; `unknown` hears an event it does not know. */
export function openCodeEventUpdates(content: OpenCodeContent, event: OpenCodeEvent, unknown?: (type: string) => void): LiveUpdate[] {
  switch (event.type) {
    case "session.text.delta":
      return content.text(event.data.sessionID, event.data.assistantMessageID, event.data.ordinal, event.data.delta)
    case "session.reasoning.delta":
      return content.reasoning(event.data.sessionID, event.data.assistantMessageID, event.data.ordinal, event.data.delta)
    case "session.tool.input.started":
      return content.toolStarted(event.data.sessionID, event.data.id, event.data.name)
    case "session.tool.called":
      return content.toolCalled(event.data.sessionID, event.data.id, event.data.input)
    case "session.tool.success":
      return content.toolEnded(event.data.sessionID, event.data.id, { content: event.data.content, metadata: event.data.metadata })
    case "session.tool.failed":
      return content.toolEnded(event.data.sessionID, event.data.id, { content: event.data.content, error: event.data.error })
    case "session.step.started":
      content.stepStarted(event.data.sessionID, event.data.assistantMessageID, event.data.agent)
      return []
    case "session.text.ended":
      content.textEnded(event.data.sessionID, event.data.assistantMessageID, event.data.ordinal, event.data.text)
      return []
    case "session.step.ended":
      return content.stepEnded(event.data.sessionID, event.data.assistantMessageID, event.data.finish)
    // Their content arrives as the deltas and tool results above; a call's progress has nothing to draw.
    case "session.tool.progress":
    case "session.text.started":
    case "session.reasoning.started":
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

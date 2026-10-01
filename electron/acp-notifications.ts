import { acpObservedSettings } from "./acp-config.js"
import type { SessionSettings } from "@mako/sessions/settings"
import { agentTitleFrom, type AttachmentContent, type ToolDetail } from "@mako/sessions"
import type {
  ContentBlock,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk"
import { normalizeAcpOptions } from "@mako/sessions/model-catalog"
import { decoded, type Decoded } from "./contracts/native-decoding.js"
import type { LiveSessionState, LiveUpdate, LiveDriverEvent } from "./shared.js"

interface AcpToolOutputBoundary {
  value: Extract<
    SessionUpdate,
    { sessionUpdate: "tool_call_update" }
  >["rawOutput"]
}

/* ------------------------------------------------------------ translation */

/**
 * ACP updates, reduced to what the panel renders. Chunks stay chunks — the
 * renderer appends them — and tool calls carry their id so later updates
 * find the block they belong to.
 */
export function forward<LiveSession extends { id: string }>(
  live: LiveSession,
  notification: SessionNotification,
  emit: (event: LiveDriverEvent) => void,
  updateState: (live: LiveSession, patch: Partial<LiveSessionState>) => void,
  currentSettings?: SessionSettings,
  toolName?: string,
  unhandled?: (kind: string) => void
): void {
  for (const item of decodeAcpUpdate(notification.update, { settings: currentSettings, toolName })) {
    if (item.kind === "update") emit({ type: "live-update", id: live.id, update: item.update })
    else if (item.kind === "state") updateState(live, item.patch)
    else if (item.kind === "unknown") unhandled?.(item.type)
  }
}

/** What an update needs beyond itself: the session's settings and the provider's name for a tool. */
export interface AcpUpdateContext {
  settings?: SessionSettings
  toolName?: string
}

/**
 * One ACP session update in the shared vocabulary. Pure, like every
 * decoder. Usage and the command list are the host's to read, so they
 * decode to nothing here; an unknown kind is reported as `session/update/<kind>`.
 */
export function decodeAcpUpdate(raw: SessionUpdate, context: AcpUpdateContext = {}): Decoded[] {
  let update: LiveUpdate
  switch (raw.sessionUpdate) {
    case "user_message_chunk":
      // Replayed history (session/load streams the past back). Live user
      // turns are emitted by livePrompt itself and never arrive this way.
      update =
        raw.content.type === "text"
          ? { kind: "user", text: raw.content.text }
          : {
              kind: "user",
              text: "",
              attachments: [contentAttachment(raw.content)],
            }
      break
    case "agent_message_chunk":
      update =
        raw.content.type === "text"
          ? { kind: "text", text: raw.content.text }
          : { kind: "attachment", attachment: contentAttachment(raw.content) }
      break
    case "agent_thought_chunk":
      update =
        raw.content.type === "text"
          ? { kind: "thinking", text: raw.content.text }
          : { kind: "attachment", attachment: contentAttachment(raw.content) }
      break
    case "tool_call": {
      update = {
        kind: "tool",
        id: raw.toolCallId,
        title: raw.title ?? "tool",
        name: context.toolName,
        toolKind: raw.kind,
        status: raw.status ?? "pending",
        ...toolContent(raw.content),
        details: withLocations(
          toolContent(raw.content).details,
          raw.locations
        ),
        input:
          raw.rawInput === undefined
            ? undefined
            : JSON.stringify(raw.rawInput, null, 2),
      }
      break
    }
    case "tool_call_update": {
      const content = toolContent(raw.content)
      update = {
        kind: "tool-update",
        id: raw.toolCallId,
        title: raw.title ?? undefined,
        status: raw.status ?? undefined,
        input:
          raw.rawInput === undefined
            ? undefined
            : JSON.stringify(raw.rawInput, null, 2),
        ...content,
        details: withLocations(content.details, raw.locations),
        output: content.output ?? parseAcpToolOutput({ value: raw.rawOutput }),
      }
      break
    }
    case "plan":
      update = {
        kind: "plan",
        entries: (raw.entries ?? []).map((entry) => ({
          content: entry.content,
          status: entry.status,
        })),
      }
      break
    case "current_mode_update":
      return [decoded.state({ currentMode: raw.currentModeId })]
    case "config_option_update":
      return [decoded.state({
        configOptions: normalizeAcpOptions(raw.configOptions),
        settings: acpObservedSettings(
          raw.configOptions,
          context.settings?.model
        ),
      })]
    case "session_info_update": {
      // A cleared title keeps the one the thread has; `updatedAt` is the agent's own bookkeeping.
      const title = agentTitleFrom(raw.title ?? undefined)
      return title ? [decoded.state({ title })] : []
    }
    // The host reads these before forwarding: the context reading and the command list.
    case "usage_update":
    case "available_commands_update":
      return []
    default:
      return [decoded.unknown(raw.sessionUpdate, null)]
  }
  return (update.kind !== "text" && update.kind !== "user") ||
    update.text ||
    (update.kind === "user" && update.attachments?.length)
    ? [decoded.update(update)]
    : []
}

function parseAcpToolOutput(
  boundary: AcpToolOutputBoundary
): string | undefined {
  const { value } = boundary
  if (value === undefined) return undefined
  if (Object.prototype.toString.call(value) === "[object String]") {
    return String(value)
  }
  return JSON.stringify(value, null, 2)
}

function contentAttachment(
  content: Exclude<ContentBlock, { type: "text" }>
): AttachmentContent {
  switch (content.type) {
    case "image":
    case "audio":
      return {
        type: "attachment",
        name: content.type,
        mimeType: content.mimeType,
        source: { kind: "inline", data: content.data },
      }
    case "resource_link":
      return {
        type: "attachment",
        name: content.title ?? content.name,
        mimeType: content.mimeType ?? "application/octet-stream",
        source: content.uri.startsWith("file://")
          ? {
              kind: "file",
              path: decodeURIComponent(new URL(content.uri).pathname),
            }
          : { kind: "url", url: content.uri },
      }
    case "resource": {
      const resource = content.resource
      return {
        type: "attachment",
        name: resource.uri,
        mimeType: resource.mimeType ?? "application/octet-stream",
        source: {
          kind: "inline",
          data:
            "blob" in resource
              ? resource.blob
              : Buffer.from(resource.text).toString("base64"),
        },
      }
    }
  }
}

interface ToolContent {
  output?: string
  attachments?: AttachmentContent[]
  details?: ToolDetail[]
}

function toolContent(
  content: Extract<
    SessionUpdate,
    { sessionUpdate: "tool_call_update" }
  >["content"]
): ToolContent {
  if (!content) return {}
  const text: string[] = []
  const attachments: AttachmentContent[] = []
  const details: ToolDetail[] = []
  for (const part of content) {
    if (part.type === "content") {
      if (part.content.type === "text") text.push(part.content.text)
      else attachments.push(contentAttachment(part.content))
    } else if (part.type === "diff") {
      details.push({type: "diff", path: part.path, oldText: part.oldText ?? null, newText: part.newText})
    } else if (part.type === "terminal")
      details.push({type: "terminal", terminalId: part.terminalId})
  }
  return {
    output: text.length ? text.join("\n") : undefined,
    attachments: attachments.length ? attachments : undefined,
    details: details.length ? details : undefined,
  }
}

/** A tool's own `locations` become file links beside its diff and terminal details. */
function withLocations(
  details: ToolDetail[] | undefined,
  locations: ReadonlyArray<{ path: string; line?: number | null }> | null | undefined
): ToolDetail[] | undefined {
  if (!locations?.length) return details
  const links: ToolDetail[] = locations.map((location) => ({
    type: "location",
    path: location.path,
    line: location.line ?? undefined,
  }))
  return [...(details ?? []), ...links]
}

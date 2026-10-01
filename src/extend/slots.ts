import type { ComponentType, ElementType, ReactNode } from "react"
import { Registry, useRegistry } from "@/extend/registry"
import type {
  GitFile,
  ChatMessage,
  SessionMeta,
  SessionSummary,
} from "@/lib/types"
import type {
  AttachmentContent,
  ToolDetail,
} from "@mako/sessions"
import type { AttachmentInput } from "@/lib/attachments"
import type { ToolIdentity, ToolKind } from "@mako/sessions/tool-identity"

/** A slot whose contributions receive nothing from the render site. */
export type NoProps = Record<never, never>

export interface RailSessionSlotProps {
  session: SessionSummary
  active: boolean
}

export interface SessionMetaSlotProps {
  meta: SessionMeta | undefined
}

export interface TranscriptTurnSlotProps {
  message: ChatMessage
}

export interface ComposerControlSlotProps extends SessionMetaSlotProps {
  disabled: boolean
  attachFiles: (files: AttachmentInput[]) => Promise<void>
  dismiss?: () => void
}

export interface ChangedFileSlotProps {
  file: GitFile
}

/**
 * Slots are the desk's declared seams. This map is the contract: adding a key
 * here is what authorizes anything to render there, and each key names the
 * exact props its contributions receive — so a contribution can never guess
 * wrong about what it is handed, and a render site can never invent a seam
 * nobody declared.
 */
export interface SlotMap {
  "titlebar.leading": NoProps
  "titlebar.trailing": NoProps
  "titlebar.status": SessionMetaSlotProps
  "rail.header": NoProps
  "rail.footer": NoProps
  "rail.session.trailing": RailSessionSlotProps
  "transcript.overlay": { conversationId?: string }
  "transcript.header": SessionMetaSlotProps
  "transcript.empty": SessionMetaSlotProps
  "transcript.turn.trailing": TranscriptTurnSlotProps
  "composer.controls": ComposerControlSlotProps
  "composer.trailing": ComposerControlSlotProps
  "composer.above": SessionMetaSlotProps
  "changes.file.trailing": ChangedFileSlotProps
}

export type SlotName = keyof SlotMap

export interface Contribution {
  slot: SlotName
  order: number
  render: ElementType
}

export const contributions = new Registry<Contribution>()

/** Contribute a component into a declared slot. Returns a disposer. */
export function registerSlot<K extends SlotName>(
  id: string,
  slot: K,
  render: ComponentType<SlotMap[K]>,
  order = 0
) {
  return contributions.register(`${slot}:${id}`, { slot, order, render })
}

/* ------------------------------------------------------------------ */
/* tool views                                                          */
/* ------------------------------------------------------------------ */

export interface ToolCall {
  id: string
  /** The harness's own name for the call; a view registered under it wins. */
  name: string
  /** ACP's kind for the call, when the harness speaks ACP. */
  kind?: string
  /** What the call is in the shared vocabulary; labels, glyphs and kind views read it. */
  tool: ToolIdentity
  /** The arguments the tool ran with: a wrapper's inner arguments when it had one. */
  arguments?: unknown
  result?: string
  attachments?: AttachmentContent[]
  details?: ToolDetail[]
  isError?: boolean
  isCanceled?: boolean
  /** See the `toolResult` block's `isCutOff`. */
  isCutOff?: boolean
  pending: boolean
  /**
   * Present while `result` is only the head of the output. The row asks for
   * the rest when it opens; a tool view can show `rest.length` meanwhile.
   */
  rest?: import("../../electron/contracts/conversation-session").ToolContentRest
}

export interface ToolViewProps {
  call: ToolCall
  expanded: boolean
}

export interface ToolView {
  /** One-line summary shown on the collapsed row. */
  summary?: (call: ToolCall) => ReactNode
  /** Body shown when the row is expanded. Falls back to raw output. */
  body?: ComponentType<ToolViewProps>
  /** A file this call can open directly from its collapsed row. */
  openPath?: (call: ToolCall) => string | undefined
  /** Overrides the default wrench glyph. */
  icon?: ComponentType<{ className?: string }>
}

const toolViews = new Registry<ToolView>()

export function registerToolView(name: string, view: ToolView) {
  return toolViews.register(name, view)
}

/**
 * Views keyed by the shared tool kind (`shell`, `edit`), used when neither the
 * native name nor the tool a wrapper ran has a view of its own. Every
 * harness's shell is a `shell`, so one view serves them all.
 */
const toolKindViews = new Registry<ToolView>()

export function registerToolKindView(kind: ToolKind, view: ToolView) {
  return toolKindViews.register(kind, view)
}

function lookup(views: Registry<ToolView>, key: string): ToolView | undefined {
  const direct = views.get(key)
  if (direct) return direct
  const normalized = key.toLowerCase()
  for (const [candidate, view] of views.entries()) {
    if (candidate.toLowerCase() === normalized) return view
  }
  return undefined
}

export function useToolView(call: Pick<ToolCall, "name" | "tool">): ToolView | undefined {
  const views = useRegistry(toolViews)
  const kindViews = useRegistry(toolKindViews)
  return lookup(views, call.name) ?? (call.tool.tool ? lookup(views, call.tool.tool) : undefined) ?? kindViews.get(call.tool.kind)
}

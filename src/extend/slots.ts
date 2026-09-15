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
  BlockAddress,
  ToolDetail,
} from "@mako/sessions"
import type { AttachmentInput } from "@/lib/attachments"

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
  name: string
  /** The provider's own kind — picks the body family when the name has no view. */
  kind?: string
  arguments?: unknown
  result?: string
  attachments?: AttachmentContent[]
  details?: ToolDetail[]
  isError?: boolean
  isCanceled?: boolean
  pending: boolean
  /**
   * Present while `result` is only the head of the output. The row asks for
   * the rest when it opens; a tool view can show `rest.length` meanwhile.
   */
  rest?: { length: number; at: BlockAddress }
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
 * Views keyed by the provider's own kind for a call — `edit`, `execute` —
 * used only when the tool's name has no view of its own. A new tool name
 * keeps a real body without registering anything.
 */
const toolKindViews = new Registry<ToolView>()

export function registerToolKindView(kind: string, view: ToolView) {
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

export function useToolView(call: Pick<ToolCall, "name" | "kind">): ToolView | undefined {
  const views = useRegistry(toolViews)
  const kindViews = useRegistry(toolKindViews)
  const direct = lookup(views, call.name)
  if (direct) return direct
  if (!call.kind) return undefined
  return lookup(kindViews, call.kind)
}

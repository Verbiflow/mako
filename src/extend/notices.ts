import type { ReactNode } from "react"
import { Registry } from "@/extend/registry"
import type { SessionMetaSlotProps } from "@/extend/slots"

/**
 * What a notice says about itself. `danger` and `caution` stop or change what
 * a send does and go first; `progress` is work under way; `info` and
 * `success` are worth knowing.
 */
export type ComposerNoticeTone = "danger" | "caution" | "progress" | "info" | "success"

export interface ComposerNoticeAction {
  label: string
  onClick(): void
  disabled?: boolean
  /** The one action the notice exists for; drawn filled. At most one per notice. */
  primary?: boolean
  title?: string
}

/**
 * One line above the composer. The title says the outcome; the description,
 * if any, is the rest of the line and is cut where the line ends. Anything
 * longer, a list or an explanation, is `detail`, opened from the line.
 */
export interface ComposerNotice {
  /** Stable across renders, so the stack keeps its place and its dismissal. */
  id: string
  tone: ComposerNoticeTone
  /** Lower goes first; by default the tone's rank (`noticeRank`). */
  priority?: number
  /** Drawn in place of the tone's glyph: the harness a notice is about. */
  icon?: ReactNode
  title: string
  description?: string
  /** The long body: what the line leaves out, shown in its popover. */
  detail?: ReactNode
  actions?: ComposerNoticeAction[]
  onDismiss?(): void
  dismissLabel?: string
  /** Test and styling hooks, set on the row. */
  data?: Record<`data-${string}`, string | boolean | undefined>
}

/** What a producer is handed: the session's meta and the key the composer keeps its draft under. */
export interface ComposerNoticeProps extends SessionMetaSlotProps {
  draftKey: string
}

/**
 * A hook that answers the notice it has now, or null. It runs in a source of
 * its own beside the stack and re-runs only when what it reads changes, so it
 * subscribes through narrow selectors as any component would.
 */
export type NoticeProducer = (props: ComposerNoticeProps) => ComposerNotice | null

export interface NoticeRegistration {
  id: string
  order: number
  use: NoticeProducer
}

export const noticeProducers = new Registry<NoticeRegistration>()

/**
 * Contribute a notice to the stack above the composer, the way the desk's
 * own notices are contributed. `order` breaks ties between notices of the
 * same rank. Returns a disposer.
 */
export function registerNotice(id: string, use: NoticeProducer, order = 0): () => void {
  return noticeProducers.register(id, { id, order, use })
}

const RANK = { danger: 0, caution: 0, progress: 1, info: 2, success: 2 } satisfies Record<ComposerNoticeTone, number>

/** Where a notice goes in the stack: urgent first, then work under way, then the rest. */
export function noticeRank(notice: Pick<ComposerNotice, "tone" | "priority">): number {
  return notice.priority ?? RANK[notice.tone]
}

/** The stack's order: rank, then the registration's order, then registration. */
export function orderNotices<T extends { notice: ComposerNotice; order: number }>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) =>
      noticeRank(left.entry.notice) - noticeRank(right.entry.notice) ||
      left.entry.order - right.entry.order ||
      left.index - right.index)
    .map(({ entry }) => entry)
}

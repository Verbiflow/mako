import type { AcpPresence } from "@/state/acp-presence"
import type { ThreadStatus } from "@/state/thread-status"

/**
 * The rail's status board: the same threads as Projects, arranged by what
 * they need from you instead of where they live.
 *
 * Projects never lets activity move a row, so the one place a thread may
 * change position with its state is here, on purpose. Sections sit in a
 * fixed order — what you must act on, then what is moving on its own, then
 * the rest — and a thread moves between them as its state changes. Inside a
 * section the newest change is first.
 */
export type BoardBucket = "needs-input" | "failed" | "review" | "working" | "done"

export const BOARD_SECTIONS: ReadonlyArray<{ key: BoardBucket; label: string }> = [
  { key: "needs-input", label: "Needs input" },
  { key: "failed", label: "Failed" },
  { key: "review", label: "Ready to review" },
  { key: "working", label: "Working" },
  { key: "done", label: "Done" },
]

export interface BoardItem<T> {
  key: string
  bucket: BoardBucket
  /** When the item entered its bucket; ISO so it sorts as text. */
  at: string
  item: T
}

export interface BoardSection<T> {
  key: BoardBucket
  label: string
  rows: BoardItem<T>[]
}

function iso(ms: number): string | undefined {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** Where a status places a thread on the board, and when it got there. */
export interface BoardPlacement {
  bucket: BoardBucket
  at?: string
}

/** Which section a thread's status puts it in, and when it got there. */
export function boardBucketOf(status: ThreadStatus): BoardPlacement {
  switch (status.kind) {
    case "needs-permission":
      return { bucket: "needs-input", at: iso(status.since) }
    case "failed":
      return { bucket: "failed", at: iso(status.at) }
    case "review":
      return status.unread
        ? { bucket: "review", at: iso(status.at) }
        : { bucket: "done" }
    case "working":
      return { bucket: "working", at: iso(status.since) }
    case "external-active":
      return { bucket: "working" }
    case "idle":
    case "observed":
    case "external-open":
      return { bucket: "done" }
  }
}

/** A live conversation not yet bound to a native thread has only its presence. */
export function liveBoardBucket(status: AcpPresence["status"]): BoardBucket {
  switch (status) {
    case "needs-permission":
      return "needs-input"
    case "failed":
      return "failed"
    case "running":
    case "starting":
      return "working"
    case "ready":
      return "done"
  }
}

/** Sections in their fixed order, each newest-change first; empty ones are left out. */
export function groupThreadBoard<T>(items: readonly BoardItem<T>[]): BoardSection<T>[] {
  const byBucket = new Map<BoardBucket, BoardItem<T>[]>()
  for (const item of items) {
    const rows = byBucket.get(item.bucket)
    if (rows) rows.push(item)
    else byBucket.set(item.bucket, [item])
  }
  return BOARD_SECTIONS.flatMap(({ key, label }) => {
    const rows = byBucket.get(key)
    if (!rows) return []
    rows.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key))
    return [{ key, label, rows }]
  })
}

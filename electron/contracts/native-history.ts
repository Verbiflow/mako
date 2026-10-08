import type { ThreadPage } from "@mako/sessions"

/** Coordinates can be combined only when their source revision agrees. */
export function nativeHistoryRevision(page: Pick<ThreadPage, "ref" | "checkpoint" | "total">): string {
  return JSON.stringify([page.ref.path, page.ref.nativeId, page.checkpoint,
    page.ref.revision, page.ref.bytes, page.ref.updatedAt, page.total])
}

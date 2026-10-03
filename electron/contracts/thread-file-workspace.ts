import type { ThreadRef } from "@mako/sessions"

/** Native adapters report folders; shared file reads never infer one from a harness name. */
export function threadFileWorkspace(ref: Pick<ThreadRef, "cwd" | "workspace" | "currentCwd">): string | undefined {
  return ref.currentCwd ?? ref.workspace ?? ref.cwd
}

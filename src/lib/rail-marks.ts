import type { ThreadPurposeKind } from "@mako/host/contracts/thread-purposes"
import { workspaceName } from "@/lib/format"
import type { AppMark } from "@/state/thread-app"
import type { WorkStatus } from "@mako/host/contracts/thread-marks"
import type { ThreadStatus } from "@/state/threads"

/** How many hues the rail's avatars take (`.rail-hue-0` to `-7` in `index.css`). */
export const AVATAR_HUES = 8

export function avatarHue(seed: string): number {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % AVATAR_HUES
}

/** The first letter or digit of a name, upper-cased: "api" is A, "@scope/x" is S, "" is "?". */
export function monogram(name: string): string {
  return (name.replace(/[^\p{L}\p{N}]/gu, "")[0] ?? "?").toUpperCase()
}

/** An app's state in words, for its mark's tip and a row's. */
export function appMarkLabel(state: AppMark["state"], port: number | undefined): string {
  if (state === "running") return port === undefined ? "App running" : `App running on port ${port}`
  if (state === "starting") return "App starting"
  if (state === "waiting") return "App waiting for memory; it starts by itself once there's room"
  return "App crashed; its Thread has the log"
}

/**
 * A row's title tone: the open one full and medium; one that needs the person, or holds an answer not yet read or a
 * Mark as unread, full; a Done one faded; the rest quieter. The title fades at its trailing edge (`rail-fade`) instead
 * of ending on an ellipsis.
 */
export function titleTone(lit: boolean, status: ThreadStatus, marks: { work?: WorkStatus | null; unread?: boolean } = {}): string {
  if (lit) return "font-medium text-foreground"
  if (status.kind === "needs-permission" || (status.kind === "review" && status.unread) || marks.unread) return "text-foreground"
  if (marks.work === "done") return "text-foreground/45"
  return "text-foreground/72"
}

/** What Mako started a Thread for, in its row's tip: the host's record names the project. */
export function purposeWords(kind: ThreadPurposeKind, project: string | undefined): string {
  return { setup: project ? `Mako started this Thread to set up ${workspaceName(project)}` : "Mako started this Thread to set this project up" }[kind]
}

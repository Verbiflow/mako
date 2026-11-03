// The live mark fixture's rows (`live-marks-check.tsx`); never imported by the application entry point.
import type { LiveMarkState } from "@/lib/live-mark-state"

export const STATES: { state: LiveMarkState; harness: string; title: string; end?: string }[] = [
  { state: "working", harness: "claude", title: "Mobile polish", end: "now" },
  { state: "background", harness: "grok", title: "Phone dictation probe", end: "3m" },
  { state: "starting", harness: "devin", title: "Wire the payments retry banner", end: "1m" },
  { state: "needs", harness: "codex", title: "Thread environments and cloud", end: "Needs you" },
  { state: "lead", harness: "opencode", title: "Sheet motion on iPad", end: "9m" },
  { state: "queued", harness: "cursor", title: "Quiet-hours push wording", end: "next" },
  { state: "open", harness: "devin", title: "Open in Devin", end: "40m" },
  { state: "failed", harness: "claude", title: "Trace the flaky webhook test", end: "Failed" },
  { state: "unread", harness: "codex", title: "Composer focus after paste", end: "14m" },
  { state: "idle", harness: "grok", title: "Tighten the webhook types", end: "3h" },
]

/** Every state the legend draws, the one place a page parameter is checked against. */
export const MARK_STATES: readonly LiveMarkState[] = STATES.map((entry) => entry.state)


import type { MarkState } from "./data"

const WORDS = {
  working: "Working",
  background: "Waiting on background work",
  starting: "Starting",
  needs: "Needs you",
  lead: "Asking its Apex",
  queued: "Queued",
  failed: "Failed",
  unread: "Answer ready",
  done: "Done",
  idle: "Idle",
} satisfies Record<MarkState, string>

export function markWord(state: MarkState): string {
  return WORDS[state]
}

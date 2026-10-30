/**
 * The one thing the phone's status capsule says above the composer, by priority: the link first (nothing else is true
 * while it's down), then a Stop on its way, then a machine waking, then the turn at work with its clock. Nothing while
 * the agent waits on the person (the card above the composer says that) or while a message is still on its way: a turn
 * is "Working" only once the host took the message and started it, never on a guess from the tap.
 */
export type DockStatus =
  | { kind: "offline" }
  | { kind: "reconnecting" }
  | { kind: "stopping" }
  | { kind: "waking"; message: boolean }
  | { kind: "working"; since: number }

export interface DockStatusInput {
  /** The browser says it has a network (`navigator.onLine`). */
  online: boolean
  /** A message's answer was lost on the way: the link is being made again, and it's asked again under its ID. */
  unconfirmed: boolean
  canceling: boolean
  /** The Thread's machine is being woken, long enough to say so (`SAY_WAKING_MS`). */
  waking: boolean
  /** A message waits on that wake. */
  wakingMessage: boolean
  /** The host started the turn (`running`): the message is delivered. */
  running: boolean
  /** When the running turn's message was sent, on the host's clock. */
  since: number | undefined
  /** An approval or a question waits on the person. */
  asking: boolean
}

export function dockStatus(input: DockStatusInput): DockStatus | undefined {
  if (!input.online) return { kind: "offline" }
  if (input.unconfirmed) return { kind: "reconnecting" }
  if (input.canceling) return { kind: "stopping" }
  if (input.waking || input.wakingMessage) return { kind: "waking", message: input.wakingMessage }
  if (input.asking) return undefined
  if (input.running && input.since !== undefined) return { kind: "working", since: input.since }
  return undefined
}

/** "Working 0s" … "Working 59s", "Working 1m 05s", "Working 1h 02m": seconds padded once there are minutes, so it doesn't jitter. */
export function workingWords(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `Working ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Working ${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `Working ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** The capsule's words for a status other than work, whose clock ticks on its own. */
export function statusWords(status: Exclude<DockStatus, { kind: "working" }>): string {
  switch (status.kind) {
    case "offline":
      return "Offline · Retry"
    case "reconnecting":
      return "Reconnecting… · Retry"
    case "stopping":
      return "Stopping…"
    case "waking":
      return status.message ? "Waking the agent… your message sends when it's ready." : "Waking…"
  }
}

/** The verbs an answer's name starts with, and what was done. */
const PAST = new Map([["Allow", "Allowed"], ["Approve", "Approved"], ["Deny", "Denied"], ["Reject", "Rejected"], ["Decline", "Declined"], ["Cancel", "Cancelled"]])

/** An answer's words as what was done: "Allow once" → "Allowed once", "Deny and stop" → "Denied and stopped". */
export function answeredWords(name: string): string {
  const [verb = "", ...rest] = name.split(" ")
  const past = PAST.get(verb)
  if (!past) return name
  return [past, ...rest.map((word) => (word === "stop" ? "stopped" : word))].join(" ")
}

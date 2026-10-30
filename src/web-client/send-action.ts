import { composerActionKind, composerEnterAction } from "@/lib/composer-action"
import type { LiveSteering } from "@/lib/types"

/**
 * What the phone's one send button does now, decided by the desk's own rules (`composer-action.ts`): Send while the
 * agent is idle; Stop while it works and the field is empty; with words while it works, Queue (after the turn) or Steer
 * (into it), as the person's Settings › Conversation choice says (`steerOnEnter`, the one the desk's Enter follows) and
 * only where the harness can take a message mid-turn; ✓ while a queued message is being edited in the field.
 */
export type SendKind = "send" | "queue" | "steer" | "stop" | "update"

export interface SendPresentation {
  kind: SendKind
  /** What it says to a screen reader, and under a long press. */
  label: string
  /** The other way to send while the agent works, offered by a long press: Queue beside Steer. */
  alternate?: "queue" | "steer"
}

export interface SendSituation {
  /** The agent is at work on a turn. */
  running: boolean
  /** The field holds words or attachments. */
  hasContent: boolean
  /** A queued message's words are in the field, being changed. */
  editingQueued: boolean
  /** The harness takes a message into a running turn (`capabilities.steering`), and its turn is running now. */
  canSteer: boolean
  /** The person's choice: a message sent while the agent works steers it, rather than waiting for the turn. */
  steerByDefault: boolean
  /** What the button says when idle: a new Thread's starts it. */
  sendLabel?: string
}

const LABELS = { queue: "Queue", steer: "Steer", stop: "Stop", update: "Save queued message" } as const

export function sendPresentation(situation: SendSituation): SendPresentation {
  if (situation.editingQueued) return { kind: "update", label: LABELS.update }
  const enter = composerEnterAction({ canSteer: situation.canSteer, steerOnEnter: situation.steerByDefault })
  const kind = composerActionKind({ running: situation.running, hasContent: situation.hasContent, steer: enter === "steer" })
  if (kind === "send" || kind === "resume") return { kind: "send", label: situation.sendLabel ?? "Send" }
  if (kind === "stop") return { kind: "stop", label: LABELS.stop }
  const presentation: SendPresentation = { kind, label: LABELS[kind] }
  if (situation.canSteer) presentation.alternate = kind === "queue" ? "steer" : "queue"
  return presentation
}

/** The one line under each choice a long press offers: what it does, in the harness's own terms. */
export function sendChoiceDetail(kind: "queue" | "steer", lands: LiveSteering | null): string {
  if (kind === "queue") return "Runs after this turn"
  return lands === "interrupt" ? "Stops the current step for this message" : "Read at its next step, mid-turn"
}

import type { ThreadEntry } from "../format.js"
import { clip } from "../format.js"
import { event, messageEvent, TURN_FAILED, type TranscriptEvent } from "../events.js"
import { backgroundCommandLabel, subagentLabel } from "../provider-turn.js"

const NOTIFICATION =
  /^\s*(?:<timestamp>[^<]*<\/timestamp>\s*)?<system_notification>([\s\S]*?)<\/system_notification>\s*<user_query>[\s\S]*?<\/user_query>\s*$/

interface TaskNotification {
  kind?: string
  status?: string
  title?: string
  /** "has notified": the task reported progress and is still running. */
  progress: boolean
  /** What the task answered, when the notification carries it. */
  response?: string
}

function taskNotification(text: string): TaskNotification | undefined {
  const match = NOTIFICATION.exec(text)
  if (!match) return undefined
  const notification = match[1] ?? ""
  const task = /<task>\s*([\s\S]*?)\s*<\/task>/.exec(notification)?.[1]
  if (!task) return undefined
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(task)?.[1]?.trim()
  return {
    kind: field("kind"),
    status: field("status"),
    title: field("title"),
    progress: /\btask has notified\b/.test(notification),
    response:
      /<response>\s*([\s\S]*?)\s*<\/response>/.exec(task)?.[1] ??
      /<user_visible_high_level_summary>\s*([\s\S]*?)\s*<\/user_visible_high_level_summary>/.exec(task)?.[1],
  }
}

/** Cursor inserts task completions as user-role records; they are work results, not user turns. */
export function cursorTaskNotification(
  text: string,
  id: string,
  at?: string
): ThreadEntry | undefined {
  const match = NOTIFICATION.exec(text)
  if (!match) return undefined
  const task = /<task>\s*([\s\S]*?)\s*<\/task>/.exec(match[1]!)?.[1]
  if (!task) return undefined
  const title = /^title:\s*(.+)$/m.exec(task)?.[1] ?? "Background task"
  const status = /^status:\s*(\S+)$/m.exec(task)?.[1]
  const output =
    /<response>\s*([\s\S]*?)\s*<\/response>/.exec(task)?.[1] ??
    /<user_visible_high_level_summary>\s*([\s\S]*?)\s*<\/user_visible_high_level_summary>/.exec(
      task
    )?.[1] ??
    task
  return {
    kind: "assistant",
    id,
    at,
    blocks: [
      {
        type: "tool",
        name: "Task result",
        id: `notification:${id}`,
        input: JSON.stringify({ description: title }),
        output: clip(output),
        error: status === "failed",
        canceled: status === "cancelled" || status === "canceled",
      },
    ],
  }
}

/**
 * A task notification opens the turn Cursor runs on it, in the words every
 * harness uses for a turn the provider started itself. Cursor wraps it in a
 * user record with a fixed instruction to the model, which is not the
 * user's and is not shown.
 */
export function cursorTaskOpener(text: string, id: string, at?: string): ThreadEntry | undefined {
  const task = taskNotification(text)
  if (!task) return undefined
  const state = /^(?:error|failed|failure)$/i.test(task.status ?? "")
    ? "failed"
    : /^(?:cancell?ed|aborted)$/i.test(task.status ?? "")
      ? "cancelled"
      : "completed"
  const label = task.progress
    ? `${task.title ? `"${task.title.slice(0, 200)}"` : "A background task"} reported progress`
    : task.kind === "shell"
      ? backgroundCommandLabel({ description: task.title, failed: state === "failed", stopped: state === "cancelled" })
      : subagentLabel({ description: task.title, state })
  const detail = task.progress ? /^detail:\s*(.+)$/m.exec(text)?.[1] : undefined
  const entry: Extract<ThreadEntry, { kind: "event" }> = {
    kind: "event",
    id,
    ...event(label, undefined, task.response ?? detail),
    opensTurn: true,
  }
  if (at) entry.at = at
  if (state === "failed") entry.tone = "error"
  return entry
}

/**
 * A message Cursor sent in the user's place for something they clicked:
 * building a plan, committing, starting parallel agents. It opens the turn,
 * but its text is Cursor's canned instruction, not the user's words.
 * `simulatedMsgReason` 3 is a task notification, handled above.
 */
export function cursorSimulatedOpener(text: string, id: string, at?: string): ThreadEntry {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean)
  const plan = lines[1]?.startsWith("Implement the plan as specified")
  const first = lines[0] ?? "Cursor sent a message"
  const entry: Extract<ThreadEntry, { kind: "event" }> = {
    kind: "event",
    id,
    ...(plan
      ? event("Implement plan", first, text)
      : event(first.length > 120 ? `${first.slice(0, 119)}…` : first, undefined, lines.length > 1 ? text : undefined)),
    opensTurn: true,
  }
  if (at) entry.at = at
  return entry
}

/** A failed turn: a short reason beside the label, a longer one opened on demand. */
export function cursorFailure(message: string): TranscriptEvent {
  return messageEvent(TURN_FAILED, message, "error")
}

/** Keep user-authored XML intact unless the whole prompt has the native wrapper. */
export function cursorPrompt(text: string): string {
  const match =
    /^\s*(?:<timestamp>[^<]*<\/timestamp>\s*)?<user_query>([\s\S]*?)<\/user_query>\s*$/.exec(
      text
    )
  return match?.[1]?.trim() ?? text
}

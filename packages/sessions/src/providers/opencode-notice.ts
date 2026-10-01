import { backgroundCommandLabel, PROVIDER_TURN_FALLBACK, subagentLabel } from "../provider-turn.js"

/** A synthetic message OpenCode writes to a session, live or stored; `source` and `state` come from its metadata. */
export interface OpenCodeNotice {
  text?: string
  description?: string
  source?: string
  state?: string
}

/**
 * OpenCode 2.0.1 writes a synthetic message to a session when work it left
 * running ends, and runs a turn on it if the session is idle:
 * - `metadata.source` "shell": a background command, text
 *   `<shell id="…" state="completed|error" command="…">output…Command exited with code 0.</shell>`,
 *   the exit line absent for a removed shell;
 * - "subagent": a background subagent, state "completed" or "cancelled";
 * - none: its own notice, such as "The server restarted while you were working. …".
 */
export function openCodeNoticeLabel(notice: OpenCodeNotice): string {
  const { source, state } = notice
  const text = notice.text ?? ""
  if (source === "subagent")
    return subagentLabel({
      description: notice.description,
      state: state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : state === "error" ? "failed" : undefined,
    })
  if (source === "shell") {
    const exitCode = /Command exited with code (-?\d+)\.\s*<\/shell>\s*$/.exec(text)?.[1]
    return backgroundCommandLabel({
      description: notice.description,
      command: /^<shell\b[^>]*\bcommand="([^"]*)"/.exec(text)?.[1],
      exitCode: exitCode === undefined ? undefined : Number(exitCode),
      failed: state === "error",
    })
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 500) || PROVIDER_TURN_FALLBACK
}

/**
 * A synthetic message that only instructs the model, like the
 * `<system-reminder>` Plan mode writes ahead of each prompt. It isn't a
 * notice and opens no turn.
 */
export function isOpenCodeInstruction(notice: OpenCodeNotice): boolean {
  return notice.source === undefined && /^\s*<system-reminder>/.test(notice.text ?? "")
}

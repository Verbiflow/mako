import { messageEvent, type TranscriptEvent } from "../events.js"

const AUTHENTICATION = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "verification_required",
  "cloud_credential_error",
])

/**
 * A message Claude Code composed to report an API failure (`isApiErrorMessage`
 * in history, `error` on a live assistant message), as the marker it is
 * rather than as the model's words. `kind` is its `error`.
 */
export function claudeApiErrorEvent(kind: string, text: string): TranscriptEvent {
  if (kind === "rate_limit") return messageEvent("Rate limited", text, "warning")
  if (kind === "max_output_tokens") return messageEvent("Warning", text, "warning")
  return messageEvent(AUTHENTICATION.has(kind) ? "Authentication failed" : "API error", text, "error")
}

/** The summary a compaction kept, without the preamble Claude Code writes for the model. */
export function claudeCompactSummary(text: string): string {
  return text.replace(/^\s*This session is being continued from a previous conversation[^\n]*\n+/, "").trim()
}

/**
 * A `local_command` record: the slash command a user ran in the terminal
 * (`/model`), or what it printed.
 */
export type ClaudeLocalCommand =
  | { kind: "command"; command: string }
  | { kind: "output"; output: string; failed: boolean }

export function claudeLocalCommand(content: string): ClaudeLocalCommand {
  const name = /<command-name>([^<\n]+)<\/command-name>/.exec(content)?.[1]?.trim()
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(content)?.[1]?.trim()
    const command = name.startsWith("/") ? name : `/${name}`
    return { kind: "command", command: args ? `${command} ${args}` : command }
  }
  const output = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/.exec(content)
  return output
    ? { kind: "output", output: output[2]?.trim() ?? "", failed: output[1] === "stderr" }
    : { kind: "output", output: content.trim(), failed: false }
}

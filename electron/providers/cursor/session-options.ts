import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import type { AcpOptionsRepair } from "../acp-source.js"

/**
 * cursor-agent builds a session's config options from the model list it
 * fetches from its backend (`fetchAvailableModelsForAcp`). When that fetch
 * fails it logs at debug level, treats the list as empty, and still answers
 * `session/new`: `mode` as usual, `model` as a select with the current model
 * as its value and no choices at all, and none of the parameter options
 * (`context`, `reasoning`/`effort`, `thinking`, `fast`) it derives from the
 * current model's definition. Seen 2026-09-13 (cursor-agent 2026.09.10): a
 * `session/new` that took 15.8 s answered that way, and applying the saved
 * `context` was refused as "cannot change context in the running session".
 *
 * Setting `model` makes the agent fetch the list again and rebuild the set,
 * so that is the repair; the model chosen for the session is the value the
 * tuning is about to select, or the one the agent already reports.
 */
export function cursorDegradedOptions(
  options: SessionConfigOption[],
  model: string | undefined
): AcpOptionsRepair | undefined {
  const modelOption = options.find(
    (option) => option.category === "model" || option.id === "model"
  )
  if (!modelOption || modelOption.type !== "select") return undefined
  const choices = modelOption.options.flatMap((entry) =>
    "options" in entry ? entry.options : [entry]
  )
  if (choices.length > 0) return undefined
  const value = model || modelOption.currentValue
  return {
    reason: CURSOR_MODEL_LIST_UNAVAILABLE,
    request: value ? { configId: modelOption.id, value } : undefined,
  }
}

/** Worded so the failure classifies as a dropped connection: retriable, "Send again" offered. */
export const CURSOR_MODEL_LIST_UNAVAILABLE =
  "Cursor could not load its model list because its backend connection failed, so this session offers no model or option choices to apply the selection to. Send the message again once Cursor can reach its service."

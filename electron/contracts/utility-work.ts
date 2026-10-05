/**
 * Small jobs Mako gives a model outside every conversation. Each runs on a
 * harness's light model at low reasoning (`harness-defaults.ts`): drafting a
 * commit message or a pull request description needs speed, not depth. Setting a project up is a whole
 * Session on the harness's model for new conversations instead. Both take
 * the first signed-in harness in the person's harness order.
 */
export const UTILITY_TASKS = ["commit"] as const

export type UtilityTask = (typeof UTILITY_TASKS)[number]

/** The first signed-in harness in the person's order, on its light model; else the first model connection. */
export const AUTOMATIC = "auto"

/** A harness's model; a model connection's id stays `<provider>/<model>`. */
export function agentModelId(harness: string, model: string): string {
  return `agent:${harness}/${model}`
}

export function parseAgentModelId(id: string): { harness: string; model: string } | undefined {
  const match = /^agent:([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(id)
  return match ? { harness: match[1]!, model: match[2]! } : undefined
}

/** The model and who runs it, as a person reads them. */
export function utilityModelName(option: { label: string; via: string }): string {
  return `${option.label} · ${option.via}`
}

/** A model that can do a task, as Settings lists it. */
export interface UtilityModelOption {
  id: string
  /** The model's own name, as its harness or provider gives it. */
  label: string
  /** Where it runs: a harness's name, or a provider's. */
  via: string
  kind: "agent" | "connection"
  /** The harness or model provider, for its icon. */
  source: string
  /** Mako's light model for its harness. */
  light?: boolean
}

export interface UtilityTaskState {
  /** What the person chose: `auto` or a model's id. */
  choice: string
  /** What runs the task now. */
  resolved?: UtilityModelOption
  /** Why nothing runs it, when nothing does. */
  reason?: string
  /** What can be chosen: each signed-in harness's models, light first, then each model connection. */
  options: UtilityModelOption[]
}

export interface UtilityWorkSettings {
  commit: UtilityTaskState
  /** The harness order the person saved; empty until they reorder. */
  harnessOrder: string[]
  /** The harnesses Mako can draft commits through. */
  runners: string[]
}

/** What each task is set to: `auto` or a model's id. */
export interface UtilityWorkChoices {
  commit: string
}

/** The harness order a person saves: harness ids, most preferred first. */
export const HARNESS_ORDER_LIMIT = 20

/**
 * Small jobs Mako gives a model outside every conversation: today, drafting
 * a commit message. Each runs on one of the person's API connections, never
 * a harness (`utility-work.ts` says why). Setting a project up is a whole
 * Session on a harness instead, the first signed-in one in the person's
 * harness order.
 */
export const UTILITY_TASKS = ["commit"] as const

export type UtilityTask = (typeof UTILITY_TASKS)[number]

/** The first connection, in provider order. */
export const AUTOMATIC = "auto"

/** The model and who runs it, as a person reads them. */
export function utilityModelName(option: { label: string; via: string }): string {
  return `${option.label} · ${option.via}`
}

/** A connected model, as Settings lists it. Its id is `<provider>/<model>`. */
export interface UtilityModelOption {
  id: string
  /** The model's own name, as its provider gives it. */
  label: string
  /** The provider's name. */
  via: string
  /** The provider, for its icon. */
  source: string
}

export interface UtilityTaskState {
  /** What the person chose: `auto` or a connection's id. */
  choice: string
  /** What runs the task now. */
  resolved?: UtilityModelOption
  /** Why nothing runs it, when nothing does. */
  reason?: string
  /** Every connection the host can open now. */
  options: UtilityModelOption[]
}

export interface UtilityWorkSettings {
  commit: UtilityTaskState
}

/** What each task is set to: `auto` or a connection's id. */
export interface UtilityWorkChoices {
  commit: string
}

/** The harness order a person saves: harness ids, most preferred first. */
export const HARNESS_ORDER_LIMIT = 20

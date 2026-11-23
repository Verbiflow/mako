/**
 * Small jobs Mako gives a model outside every conversation: drafting a
 * commit message, and titling a Thread once the person turns that on
 * (`THREAD_TITLES`). Each runs on one of the person's API connections, never
 * a harness (`utility-work.ts` says why). Setting a project up is a whole
 * Session on a harness instead, the first signed-in one in the person's
 * harness order.
 */
export const UTILITY_TASKS = ["commit"] as const

export type UtilityTask = (typeof UTILITY_TASKS)[number]

/**
 * The switch for generated Thread titles, as `mako:utility-choice` names it:
 * `on` or `off`. It has no model of its own: a title is asked of the
 * connection `commit` uses. Off until the person turns it on, because a
 * title sends a Thread's first prompt and the start of its answer to that
 * connection's provider, which need not be the one the Thread's harness
 * talks to.
 */
export const THREAD_TITLES = "titles"

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
  /** Whether Threads are titled on the connection `commit` resolves to (`THREAD_TITLES`). */
  titles?: boolean
}

/** What each task is set to: `auto` or a connection's id. */
export interface UtilityWorkChoices {
  commit: string
  /** `THREAD_TITLES`, when the person turned it on. */
  titles?: boolean
}

/** The harness order a person saves: harness ids, most preferred first. */
export const HARNESS_ORDER_LIMIT = 20

import type { ComponentType } from "react"
import type { LucideIcon } from "lucide-react"

/** The five nav groups, in the order the rail lists them. */
export const SETTINGS_GROUPS = [
  "Providers",
  "Desk",
  "Project",
  "Extensions",
  "Application",
] as const

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

/**
 * One settings section: what the nav calls it, where it sits, what the
 * search index knows it by, and what renders in the panel. Ids are part of
 * the deep-link contract — `mako:settings` events carry them — so they never
 * change even when a title does.
 */
export interface SettingsSection {
  readonly id: string
  readonly title: string
  readonly group: SettingsGroup
  readonly icon: LucideIcon
  readonly keywords: readonly string[]
  readonly Component: ComponentType
}

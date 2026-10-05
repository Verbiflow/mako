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
  /** The section has a row per harness, so every harness's name finds it too. */
  readonly perHarness?: true
  readonly Component: ComponentType
}

/** A section's search words: its own, and every harness's names when it has a row per harness. */
export function sectionKeywords(
  section: SettingsSection,
  harnesses: readonly { provider: string; displayName: string }[]
): readonly string[] {
  return section.perHarness
    ? [...section.keywords, ...harnesses.flatMap((harness) => [harness.displayName, harness.provider])]
    : section.keywords
}

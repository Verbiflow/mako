import type { ProviderCapability } from "./registry.js"

export interface SkillAccountLocation {
  name: string
  dir?: string
}

export interface ProviderSkillSource extends ProviderCapability {
  command(): string | null
  userRoots(account: SkillAccountLocation): string[]
  workspaceFolder: string
  targetUserRoot(account: SkillAccountLocation): string
  /**
   * Whether the CLI loads `~/.agents/skills` and `.agents/skills` itself.
   * Declare `true` only after a live check shows the CLI listing a skill
   * that exists in that root alone; until then a reference to such a skill
   * is handed over in the prompt, which costs a few kilobytes and never
   * fails silently.
   */
  readsUniversalRoot: boolean
}

import type { HarnessAccount } from "./harnesses.js"

export interface ProviderSkillSource {
  provider: string
  command(): string | null
  userRoots(account: HarnessAccount): string[]
  workspaceFolder: string
  targetUserRoot(account: HarnessAccount): string
  /**
   * Whether the CLI loads `~/.agents/skills` and `.agents/skills` itself.
   * Declare `true` only after a live check shows the CLI listing a skill
   * that exists in that root alone; until then a reference to such a skill
   * is handed over in the prompt, which costs a few kilobytes and never
   * fails silently.
   */
  readsUniversalRoot: boolean
  /**
   * Whether the CLI loads the project's skills in `cwd`, its own folder's
   * and `.agents/skills`; always, when absent. A project skill it won't load
   * there is handed over like one from another provider.
   */
  readsWorkspace?(cwd: string): boolean
}

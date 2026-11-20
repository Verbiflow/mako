import { z } from "zod"

/**
 * What the person sets for one project in Settings › Projects, kept by the host per repository
 * (`<user root>/project-settings.json`), so every window, profile and start on this Mac reads the same.
 *
 * `baseBranch` is where a new Thread's worktree branch starts: a branch or remote branch of the repository
 * (`main`, `origin/main`). Null keeps Mako's own rule (`WorktreeStarts.point`): the project folder's branch, or its
 * upstream when that is ahead.
 */
export const ProjectSettingsChangeSchema = z.object({
  baseBranch: z.string().trim().min(1).max(255).regex(/^[^\s~^:?*[\\]+$/, "That isn't a branch name").nullable(),
}).strict()
export type ProjectSettingsChange = z.infer<typeof ProjectSettingsChangeSchema>

/** One project's settings as Settings › Projects shows them. */
export interface ProjectSettingsView {
  /** The folder asked about. */
  folder: string
  /** Its repository's top folder, where the settings are kept; null for a folder of several repositories or none. */
  repository: string | null
  /** The branch new Threads start from, as the person chose it; null: Mako's own rule. */
  baseBranch: string | null
  /** Where a new Thread would start by Mako's own rule now (`main`, `origin/main`); null when Git can't say. */
  automatic: string | null
  /** The chosen branch isn't in the repository: Threads start by Mako's own rule until it is again. */
  missing: boolean
  /** The GitHub repository cloud Threads and automations of this project use, as `owner/name`, from its `origin`; null when `origin` isn't on GitHub. */
  cloud: string | null
}

/** `https://github.com/acme/api` (or a remote URL already turned into one) as `acme/api`. */
export function githubOwnerName(url: string): string | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(url)
  return match ? `${match[1]}/${match[2]}` : null
}

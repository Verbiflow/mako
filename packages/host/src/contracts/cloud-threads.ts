import { z } from "zod"

/** A public GitHub repository a cloud Thread's machine clones and works in, as the cloud takes it. */
export const CloudRepositorySchema = z
  .object({
    url: z
      .string()
      .max(200)
      .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected https://github.com/<owner>/<repository>"),
    branch: z
      .string()
      .max(200)
      .regex(/^(?![-/.])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_./-]+(?<![./])$/, "expected a branch name")
      .optional(),
  })
  .strict()

export type CloudRepository = z.infer<typeof CloudRepositorySchema>

/**
 * Where a new conversation runs: on a cloud machine of the account's, in a clone of `repository`, or without one,
 * of the GitHub repository the folder's `origin` names, on its upstream branch when it has one there.
 */
export interface CloudPlacement {
  repository?: CloudRepository
}

const SSH_REMOTE = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
const HTTPS_REMOTE = /^https:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/

/** The GitHub repository a Git remote's URL names, as the cloud takes it; undefined for any other host. */
export function githubRepositoryUrl(remote: string): string | undefined {
  const match = SSH_REMOTE.exec(remote.trim()) ?? HTTPS_REMOTE.exec(remote.trim())
  return match ? `https://github.com/${match[1]}/${match[2]}` : undefined
}

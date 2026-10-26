import { z } from "zod"

/**
 * A project's carried files in Mako Cloud: the files its recipe's `carry` names (`.env`, a local settings file), which
 * Git leaves out, so a Thread moved to the cloud would arrive without them. With its person's permission, given once
 * per project, Mako keeps a copy of each in the account's secret store, encrypted, and every cloud Thread of the
 * project gets them as it starts. The recipe's `carry` list is the only list: the same files a new worktree here gets.
 */

/** One file as the account's store lists it: its path in the checkout, never its value. */
export const CloudCarriedFileSchema = z.object({
  path: z.string().min(1).max(300),
  version: z.string().min(1).max(100),
  bytes: z.number().int().nonnegative(),
  /** The variables it defines, read on this Mac: what a recipe's named secrets are checked against in the cloud. */
  names: z.array(z.string()).max(200),
  savedAt: z.string(),
})
export type CloudCarriedFile = z.infer<typeof CloudCarriedFileSchema>

/** The person's word for a project: not asked yet, copy its files to the cloud, or keep them on this Mac. */
export type CarriedFilesDecision = "unasked" | "allowed" | "declined"

/** One file the recipe carries, as Settings and the move's question show it. */
export type CarriedFileView = {
  path: string
  bytes: number
  /** Named like a credentials file (`.env`, a key file). */
  credentials: boolean
  /** In the cloud now, and whether that copy is this Mac's current one. */
  cloud: { savedAt: string; current: boolean } | null
  /** The person removed it from the cloud: it stays on this Mac until they copy it again. */
  kept: boolean
}

/** What a project carries to the cloud, and where it stands. */
export type CarriedFilesView = {
  /** The project's main checkout, where the files are read. */
  project: string
  /** The project's GitHub repository, which the cloud knows it by; null for a project the cloud can't run. */
  repository: string | null
  decision: CarriedFilesDecision
  files: CarriedFileView[]
  /** What the recipe carries that doesn't go, and why: a linked folder, a file too large, too many. */
  staying: Array<{ path: string; why: string }>
  /** Why the cloud's side couldn't be read just now, if it couldn't. */
  problem?: string
}

/** What a sync did: sent (new or changed), removed from the cloud, or left as it was. */
export type CarriedFilesSync = { sent: string[]; removed: string[]; unchanged: number }

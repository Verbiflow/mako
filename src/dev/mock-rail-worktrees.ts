import { ThreadIdSchema } from "../../electron/contracts/thread-identity"
import type { AppMark } from "../../electron/contracts/thread-app"
import type { ThreadPurpose } from "../../electron/contracts/thread-purposes"
import type { ThreadWorktree } from "../../electron/contracts/thread-worktrees"

/**
 * The fixture desk's `?mock&app=rail`: four of the api project's Threads in
 * worktrees of their own, each app in a different state, for the sidebar's
 * marks. The project folder's own app is the strip's, running. One of them
 * is the Thread Mako started to set the api project up.
 */

const ROOT = "/Users/you/.mako/worktrees"
const PROJECT = "/Users/you/api"

const MOVED: { thread: string; folder: string; branch: string; mark: Omit<AppMark, "checkout">; setup?: true }[] = [
  { thread: "/mock/claude-2.jsonl", folder: "api-billing-webhooks", branch: "mako/billing-webhooks", mark: { state: "running", port: 20_180 } },
  { thread: "/mock/codex.jsonl", folder: "api-set-up", branch: "mako/set-up-api", mark: { state: "starting" }, setup: true },
  { thread: "/mock/devin.jsonl", folder: "api-payments-queue", branch: "mako/payments-queue", mark: { state: "crashed" } },
  { thread: "/mock/grok-0.jsonl", folder: "api-retry-budget", branch: "mako/retry-budget", mark: { state: "waiting" } },
]

export const RAIL_WORKTREES: ThreadWorktree[] = MOVED.map((entry, index) => ({
  path: `${ROOT}/${entry.folder}`,
  thread: ThreadIdSchema.parse(`00000000-0000-4000-8000-00000000000${index + 1}`),
  repoRoot: PROJECT,
  project: PROJECT,
  branch: entry.branch,
  base: "4f1c2e9",
  createdAt: Date.now() - (index + 1) * 3_600_000,
}))

export const RAIL_MARKS: AppMark[] = [
  ...MOVED.map((entry) => ({ checkout: `${ROOT}/${entry.folder}`, ...entry.mark })),
  { checkout: "/Users/you/mako", state: "running", port: 20_140 },
]

export const RAIL_PURPOSES: ThreadPurpose[] = MOVED.flatMap((entry, index) => {
  const worktree = RAIL_WORKTREES[index]
  return entry.setup && worktree ? [{ thread: worktree.thread, kind: "setup" as const, project: PROJECT, createdAt: worktree.createdAt }] : []
})

/** A fixture Thread as the rail scene has it: in its worktree, under its Thread, and the setup Thread named for its job. */
export function railRef<T extends { path: string; cwd?: string; title?: string; threadId?: string }>(ref: T): T {
  const index = MOVED.findIndex((entry) => entry.thread === ref.path)
  const entry = MOVED[index]
  const worktree = RAIL_WORKTREES[index]
  if (!entry || !worktree) return ref
  const moved: T = { ...ref, cwd: worktree.path, threadId: worktree.thread }
  if (entry.setup) moved.title = "Set up api"
  return moved
}

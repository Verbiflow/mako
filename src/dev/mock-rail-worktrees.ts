import { ThreadIdSchema } from "../../electron/contracts/thread-identity"
import type { AppMark } from "../../electron/contracts/thread-app"
import type { ThreadWorktree } from "../../electron/contracts/thread-worktrees"

/**
 * The fixture desk's `?mock&app=rail`: four of the api project's Threads in
 * worktrees of their own, each app in a different state, for the sidebar's
 * marks. The project folder's own app is the strip's, running.
 */

const ROOT = "/Users/you/.mako/worktrees"

const MOVED: { thread: string; folder: string; branch: string; mark: Omit<AppMark, "checkout"> }[] = [
  { thread: "/mock/claude-2.jsonl", folder: "api-billing-webhooks", branch: "mako/billing-webhooks", mark: { state: "running", port: 20_180 } },
  { thread: "/mock/codex.jsonl", folder: "api-webhook-retry", branch: "mako/webhook-retry", mark: { state: "starting" } },
  { thread: "/mock/devin.jsonl", folder: "api-payments-queue", branch: "mako/payments-queue", mark: { state: "crashed" } },
  { thread: "/mock/grok-0.jsonl", folder: "api-retry-budget", branch: "mako/retry-budget", mark: { state: "waiting" } },
]

export const RAIL_WORKTREES: ThreadWorktree[] = MOVED.map((entry, index) => ({
  path: `${ROOT}/${entry.folder}`,
  thread: ThreadIdSchema.parse(`00000000-0000-4000-8000-00000000000${index + 1}`),
  repoRoot: "/Users/you/api",
  project: "/Users/you/api",
  branch: entry.branch,
  base: "4f1c2e9",
  createdAt: Date.now() - (index + 1) * 3_600_000,
}))

export const RAIL_MARKS: AppMark[] = [
  ...MOVED.map((entry) => ({ checkout: `${ROOT}/${entry.folder}`, ...entry.mark })),
  { checkout: "/Users/you/mako", state: "running", port: 20_140 },
]

/** Where a fixture Thread works in the rail scene: its worktree, or where it always was. */
export function railCwd(path: string, cwd: string): string {
  const moved = MOVED.find((entry) => entry.thread === path)
  return moved ? `${ROOT}/${moved.folder}` : cwd
}

import { SessionIdSchema, ThreadIdSchema } from "../../electron/contracts/thread-identity"
import type { ThreadGroup } from "../../electron/contracts/thread-groups"
import type { ThreadRunState } from "../../electron/contracts/conversation-session"
import type { AppMark, RoomApp, RoomView } from "../../electron/contracts/thread-app"
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

const TITLES = ["Billing webhooks", "Set up api", "Payments queue", "Retry budget"]
const MB = 1024 ** 2

/** The Status view's Room for the same scene, with a spare checkout installing ahead and each project's fit. */
export function railRoom(now: number): RoomView {
  const apps: RoomApp[] = MOVED.map((entry, index) => {
    const worktree = RAIL_WORKTREES[index]!
    const app: RoomApp = {
      app: worktree.thread,
      kind: "thread",
      state: entry.mark.state,
      checkout: worktree.path,
      project: { root: PROJECT, name: "api" },
      thread: { id: worktree.thread, title: TITLES[index]! },
      runs: entry.mark.state === "waiting" || entry.mark.state === "crashed" ? [] : ["api", "worker"],
      usedAt: now - (index + 2) * 7 * 60_000,
    }
    if (entry.mark.port !== undefined) app.port = entry.mark.port
    if (entry.mark.state === "running" || entry.mark.state === "starting") {
      app.memoryBytes = (entry.mark.state === "running" ? 812 : 214) * MB
      app.upAt = now - (index + 1) * 26 * 60_000
    }
    if (entry.mark.state === "waiting") app.waitingSince = now - 3 * 60_000
    return app
  })
  apps.push(
    { app: "folder-0f3a9c2b7d4e1a65", kind: "folder", state: "running", checkout: "/Users/you/mako", project: { root: "/Users/you/mako", name: "mako" }, runs: ["web"], port: 20_140, memoryBytes: 1_210 * MB, upAt: now - 12 * 60_000, usedAt: now - 60_000 },
    { app: "folder-7be21d03c9a4f812", kind: "spare", state: "starting", checkout: `${ROOT}/.spare-4d55bf64`, project: { root: PROJECT, name: "api" }, runs: ["install"], memoryBytes: 388 * MB, upAt: now - 40_000 },
  )
  return {
    at: now,
    pressure: "normal",
    freeBytes: 9.8 * 1024 * MB,
    totalBytes: 36 * 1024 * MB,
    apps,
    fits: [
      { root: PROJECT, name: "api", estimate: { kind: "ready", runs: 7, peakBytes: 860 * MB, running: 1, atOnce: 12 } },
      { root: "/Users/you/mako", name: "mako", estimate: { kind: "learning", runs: 1 } },
    ],
    marks: RAIL_MARKS,
  }
}

export const RAIL_PURPOSES: ThreadPurpose[] = MOVED.flatMap((entry, index) => {
  const worktree = RAIL_WORKTREES[index]
  return entry.setup && worktree ? [{ thread: worktree.thread, kind: "setup" as const, project: PROJECT, createdAt: worktree.createdAt }] : []
})

/**
 * The billing Thread has a second Session: Claude has answered, Grok is still
 * working in the same worktree. The rail folds them into one row.
 */
const SESSIONS = [
  { path: "/mock/claude-2.jsonl", harness: "claude", session: SessionIdSchema.parse("00000000-0000-4000-8000-0000000000a1"), run: "done" },
  { path: "/mock/grok-1.jsonl", harness: "grok", session: SessionIdSchema.parse("00000000-0000-4000-8000-0000000000a2"), run: "running" },
] as const
const SESSION_HOME = 0

export const RAIL_THREAD_GROUPS: ThreadGroup[] = [{
  id: RAIL_WORKTREES[SESSION_HOME]!.thread,
  sessions: SESSIONS.map((entry, index) => ({ id: entry.session, origin: index ? "new" : "started", started: true })),
}]

/** Grok starts before Claude finishes, so Claude's outcome lands while Grok works. */
export const RAIL_RUNS: ThreadRunState[] = SESSIONS.map((entry) => ({ path: entry.path, harness: entry.harness, status: entry.run })).reverse()

/** A fixture Thread as the rail scene has it: in its worktree, under its Thread, and the setup Thread named for its job. */
export function railRef<T extends { path: string; cwd?: string; title?: string; threadId?: string; sessionId?: string }>(ref: T): T {
  const session = SESSIONS.find((entry) => entry.path === ref.path)
  const index = session ? SESSION_HOME : MOVED.findIndex((entry) => entry.thread === ref.path)
  const entry = MOVED[index]
  const worktree = RAIL_WORKTREES[index]
  if (!entry || !worktree) return ref
  const moved: T = { ...ref, cwd: worktree.path, threadId: worktree.thread }
  if (session) moved.sessionId = session.session
  if (entry.setup) moved.title = "Set up api"
  return moved
}

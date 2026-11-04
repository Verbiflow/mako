import { toast } from "sonner"
import { desktop } from "@/state/desktop"
import { github, githubStore } from "@/state/github"
import { createHook, createStore } from "@/state/store"
import { readWorktreePulls } from "@/state/worktrees"

/**
 * How many pull requests are open in a checkout's GitHub repository, for the
 * rail's Pull requests row. One `gh pr list --state open` per checkout (the
 * one a new Thread's branch picker asks), again on focus at most every few
 * minutes: a count, not a feed.
 */

/** `gh` lists at most this many open pull requests; past it the row says "50+". */
export const OPEN_PULLS_LISTED = 50
const FRESH_MS = 5 * 60_000

interface OpenPulls {
  count: number | null
  at: number
}

export const openPullsStore = createStore<{ byRoot: Readonly<Record<string, OpenPulls>> }>({ byRoot: {} })
export const useOpenPulls = createHook(openPullsStore)

const asking = new Set<string>()

/** Asks for the count unless a fresh one is held or a question is already out. */
export function refreshOpenPulls(root: string | undefined, now = Date.now()): void {
  if (!root || asking.has(root)) return
  const held = openPullsStore.get().byRoot[root]
  if (held && now - held.at < FRESH_MS) return
  asking.add(root)
  void readWorktreePulls(root)
    .then((pulls) => pulls?.length ?? null, () => null)
    .then((count) => {
      asking.delete(root)
      openPullsStore.set({ byRoot: { ...openPullsStore.get().byRoot, [root]: { count, at: Date.now() } } })
    })
}

/** The repository's open pull requests on GitHub, the one list of them Mako doesn't draw itself. */
export async function openPullRequests(root: string | undefined): Promise<void> {
  if (!root) {
    toast("Open a project to see its pull requests")
    return
  }
  await github.ensureStatus(root)
  const { status, statusRoot } = githubStore.get()
  const repo = statusRoot === root ? status?.repo : undefined
  if (!repo) {
    toast("This project has no GitHub remote")
    return
  }
  await desktop.openUrl(`https://github.com/${repo}/pulls`)
}

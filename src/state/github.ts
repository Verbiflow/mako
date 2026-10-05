import { useEffect } from "react"
import { createHook, createStore } from "@/state/store"
import { useSession } from "@/state/session"
import { getMako, hasBridge } from "@/lib/bridge"
import type { GitHubStatus, PullRequest } from "@/lib/types"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import type { MergeMethod } from "../../electron/contracts/git-actions"

/**
 * The pull request for the branch you are on.
 *
 * Refreshed on demand rather than polled. A PR's checks do move on their own,
 * but polling GitHub every few seconds for a repo nobody is looking at is the
 * kind of background cost that shows up as a fan spinning — so it refreshes
 * when the panel appears, when the branch changes, and when you ask.
 */

export interface GitHubState {
  status?: GitHubStatus
  pull?: PullRequest | null
  loading: boolean
  /** The branch the current `pull` was fetched for, so a switch invalidates it. */
  branch?: string
  root?: string
  statusRoot?: string
  /** The signed-in user's avatar as a data URL, for the identity badge. */
  userAvatar?: string
}

export const githubStore = createStore<GitHubState>({ loading: false })
export const useGitHub = createHook(githubStore)

let statusGeneration = 0
let pullGeneration = 0
let statusLoad: Promise<void> | null = null
let statusLoadRoot: string | undefined
/** Pull request reads in flight by repository and branch, so every panel that asks shares one. */
const refreshing = new Map<string, Promise<void>>()

async function readPull(root: string, branch?: string) {
  if (!hasBridge()) return
  await github.ensureStatus(root)
  const status = githubStore.get()
  if (status.root !== root || status.statusRoot !== root) return
  if (!status.status?.authenticated || !status.status.repo) {
    githubStore.set({ pull: null, loading: false, branch, root })
    return
  }
  const mine = ++pullGeneration
  githubStore.set({ loading: true })
  const pull = await getMako().pullRequest().catch(() => null)
  if (mine !== pullGeneration || githubStore.get().root !== root) return
  githubStore.set({ pull, loading: false, branch, root })
}

export const github = {
  async ensureStatus(root?: string) {
    if (!hasBridge()) return
    const current = githubStore.get()
    if (
      current.status &&
      (root === undefined || current.statusRoot === root)
    )
      return
    if (statusLoad && (root === undefined || statusLoadRoot === root))
      return statusLoad
    const mine = ++statusGeneration
    if (root !== undefined) {
      pullGeneration += 1
      githubStore.set({
        root,
        pull: null,
        branch: undefined,
        loading: true,
      })
    }
    statusLoadRoot = root
    statusLoad = getMako()
      .githubStatus()
      .then((status) => {
        if (mine !== statusGeneration) return
        githubStore.set({
          status,
          statusRoot: root,
          root: root ?? current.root,
          loading: false,
          userAvatar: status.authenticated
            ? githubStore.get().userAvatar
            : undefined,
        })
        void github.ensureUserAvatar()
      })
      .catch(() => {
        if (mine === statusGeneration) githubStore.set({ loading: false })
      })
      .finally(() => {
        if (mine !== statusGeneration) return
        statusLoad = null
        statusLoadRoot = undefined
      })
    return statusLoad
  },

  /** Best effort and quiet: no avatar means a monogram, never a toast. */
  async ensureUserAvatar() {
    if (!hasBridge()) return
    const { status, userAvatar } = githubStore.get()
    if (userAvatar || !status?.authenticated) return
    const avatar = await getMako().userAvatar().catch(() => undefined)
    if (avatar) githubStore.set({ userAvatar: avatar })
  },

  refresh(root: string, branch?: string): Promise<void> {
    const key = JSON.stringify([root, branch ?? null])
    const running = refreshing.get(key)
    if (running) return running
    const next = readPull(root, branch).finally(() => refreshing.delete(key))
    refreshing.set(key, next)
    return next
  },

  listBranches(): Promise<string[]> {
    return getMako().pullBranches()
  },

  async create(options: { title: string; body: string; base?: string; draft?: boolean }) {
    const root = githubStore.get().root
    const pull = await getMako().createPull(options)
    if (githubStore.get().root === root) githubStore.set({ pull })
    return pull
  },

  async merge(strategy: MergeMethod) {
    const root = githubStore.get().root
    const pull = await getMako().mergePull(strategy)
    if (githubStore.get().root === root) githubStore.set({ pull })
    return pull
  },

  /** Re-run the failed GitHub Actions runs on the pushed commit, and say what happened. */
  async rerun() {
    const { root, branch } = githubStore.get()
    if (!root) return
    try {
      const runs = await getMako().rerunChecks()
      if (runs) toast.success(runs === 1 ? "Re-running the failed run" : `Re-running ${runs} failed runs`)
      else toast.info("No GitHub Actions run failed on the pushed commit", { description: "A check from another service re-runs from its own page; Open on GitHub has its link." })
    } catch (error) {
      toast.error("Checks were not re-run", { duration: ACTION_TOAST_MS, description: error instanceof Error ? error.message : String(error) })
    }
    await github.refresh(root, branch)
  },
}

export interface BranchPull {
  status: GitHubStatus
  pull: PullRequest | null
  loading: boolean
  branch: string | undefined
  root: string
}

/** GitHub's word on the checked-out branch, read when the branch or repository changes; null until it's for them. */
export function useBranchPull(): BranchPull | null {
  const state = useGitHub((current) => current)
  const branch = useSession((current) => current.git?.branch)
  const root = useSession((current) => current.git?.root)
  const { status, pull, loading, branch: cached, root: cachedRoot, statusRoot } = state
  useEffect(() => {
    if (!root) return
    if (cachedRoot !== root || statusRoot !== root || cached !== branch) void github.refresh(root, branch)
  }, [branch, cached, cachedRoot, root, statusRoot])
  if (!root || cachedRoot !== root || statusRoot !== root || cached !== branch || !status) return null
  return { status, pull: pull ?? null, loading, branch, root }
}

const composerStore = createStore<{ root: string | null }>({ root: null })
const useComposerStore = createHook(composerStore)

/** The pull request form, opened by the Git control or by Commit and open pull request, for one repository at a time. */
export const pullComposer = {
  open(root: string) {
    composerStore.set({ root })
  },
  close() {
    composerStore.set({ root: null })
  },
}

export function usePullComposer(root: string | undefined): boolean {
  return useComposerStore((state) => Boolean(root) && state.root === root)
}

import { getMako } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"
import { actions, store } from "@/state/session"
import type { GitPushInput, GitRemoteAction } from "@/lib/types"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"

type PushState =
  | { kind: "idle" }
  | { kind: "syncing"; branch: string; action: GitRemoteAction }
  | { kind: "pushing"; branch: string }
  | { kind: "pushed"; branch: string; at: number }
  | { kind: "failed"; branch: string; message: string; detail?: string; reason?: "incoming" | "conflicts" | "dirty" | "failed" }

const idle: PushState = { kind: "idle" }
const pushStore = createStore<{ branches: Map<string, PushState> }>({
  branches: new Map(),
})
const usePushStore = createHook(pushStore)
const pending = new Map<string, Promise<void>>()
const keyOf = (cwd: string, branch: string) => JSON.stringify([cwd, branch])

export function useGitPush(cwd: string, branch: string) {
  return usePushStore((state) => state.branches.get(keyOf(cwd, branch)) ?? idle)
}

function update(key: string, state: PushState) {
  pushStore.set((current) => {
    const branches = new Map(current.branches)
    branches.set(key, state)
    return { branches }
  })
}

export function pushCurrentBranch(): Promise<void> {
  const snapshot = store.get().git
  if (!snapshot?.root || !snapshot.branch || !snapshot.head) {
    toast.error("Choose a branch with commits before pushing", {
      duration: ACTION_TOAST_MS,
      action: {
        label: "Refresh changes",
        onClick: () => void actions.refreshGit(),
      },
    })
    return Promise.resolve()
  }
  return pushBranch({ cwd: snapshot.root, branch: snapshot.branch })
}

export function pushBranch(target: GitPushInput): Promise<void> {
  const key = keyOf(target.cwd, target.branch)
  const active = pending.get(key)
  if (active) return active
  toast.dismiss(`git-push:${key}`)
  update(key, { kind: "pushing", branch: target.branch })
  const request = performPush(target, key).finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}

async function performPush(target: GitPushInput, key: string) {
  try {
    const current = store.get().git
    if ((current?.root ?? current?.cwd) !== target.cwd || current?.branch !== target.branch)
      throw new Error(
        "Select this project and branch before retrying the push."
      )
    if (current.operation) throw new Error(`Finish or abort the ${current.operation} before pushing.`)
    if (current.behind > 0) throw new Error("Pull incoming commits before pushing.")
    await getMako().gitPush(target)
    if ((store.get().git?.root ?? store.get().git?.cwd) === target.cwd) await actions.refreshGit()
    const at = Date.now()
    update(key, { kind: "pushed", branch: target.branch, at })
    setTimeout(() => {
      const state = pushStore.get().branches.get(key)
      if (state?.kind === "pushed" && state.at === at) update(key, idle)
    }, 3_000)
  } catch (error) {
    let incoming = false
    try {
      const current = store.get().git
      const result = await getMako().gitRemote({ ...target, head: current?.head, action: "fetch" })
      incoming = result.status.behind > 0
      if (store.get().git?.root === target.cwd) await actions.refreshGit()
    } catch { /* The original failure remains available in Git details. */ }
    const message = incoming ? "Remote commits need to be pulled before you can push." : "Could not push. Check the remote connection and Git details."
    const detail = incoming ? undefined : error instanceof Error ? error.message : String(error)
    update(key, { kind: "failed", branch: target.branch, message, detail, reason: incoming ? "incoming" : "failed" })
    toast.error(incoming ? "Pull incoming commits before pushing" : "Could not push", {
      id: `git-push:${key}`, duration: ACTION_TOAST_MS,
    })
  }
}

export function runGitRemote(action: GitRemoteAction): Promise<void> {
  const snapshot = store.get().git
  if (!snapshot?.root || !snapshot.branch) return Promise.resolve()
  const target = { cwd: snapshot.root, branch: snapshot.branch, head: snapshot.head, action }
  const key = keyOf(target.cwd, target.branch)
  const active = pending.get(key)
  if (active) return active
  toast.dismiss(`git-push:${key}`)
  update(key, { kind: "syncing", branch: target.branch, action })
  const request = (async () => {
    try {
      const result = await getMako().gitRemote(target)
      if (store.get().git?.root === target.cwd) await actions.refreshGit()
      if (result.problem) update(key, { kind: "failed", branch: target.branch, message: result.problem.message, detail: result.problem.detail, reason: result.problem.kind })
      else update(key, idle)
    } catch (error) {
      update(key, { kind: "failed", branch: target.branch, message: "Git could not finish. Refresh and review the details before trying again.", detail: error instanceof Error ? error.message : String(error) })
      if (store.get().git?.root === target.cwd) await actions.refreshGit()
    }
  })().finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}

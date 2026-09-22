import { getMako } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"
import { actions, store } from "@/state/session"
import type { GitPushInput } from "@/lib/types"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"

type PushState =
  | { kind: "idle" }
  | { kind: "pushing"; branch: string }
  | { kind: "pushed"; branch: string; at: number }
  | { kind: "failed"; branch: string; message: string }

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
    await getMako().gitPush(target)
    if ((store.get().git?.root ?? store.get().git?.cwd) === target.cwd) await actions.refreshGit()
    const at = Date.now()
    update(key, { kind: "pushed", branch: target.branch, at })
    setTimeout(() => {
      const state = pushStore.get().branches.get(key)
      if (state?.kind === "pushed" && state.at === at) update(key, idle)
    }, 3_000)
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The branch could not be pushed. Check the remote and try again."
    update(key, { kind: "failed", branch: target.branch, message })
    toast.error(`Could not push ${target.branch}`, {
      id: `git-push:${key}`,
      duration: ACTION_TOAST_MS,
      description: message,
      action: { label: "Retry push", onClick: () => void pushBranch(target) },
    })
  }
}

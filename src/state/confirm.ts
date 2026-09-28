import { createHook, createStore } from "@/state/store"

/** One thing the action touches, named exactly, with what becomes of it. */
export interface ConfirmSubject {
  kind: "folder" | "branch"
  name: string
  /** A word or two: "Deleted", "Kept", "3 commits". */
  detail?: string
  /** The detail says it goes away. */
  lost?: boolean
}

export interface ConfirmRequest {
  title: string
  body: string
  /** The confirming button's label: the action itself, never "OK". */
  confirm: string
  /** Negative for an action that deletes something. */
  tone?: "negative" | "default"
  icon?: "remove" | "merge"
  subjects?: readonly ConfirmSubject[]
  /** Subjects past the shown ones, counted in a last row. */
  more?: number
  /** A quieter line under the subjects: what else goes with them. */
  note?: string
}

interface ConfirmState {
  request: (ConfirmRequest & { answer: (confirmed: boolean) => void }) | null
}

export const confirmStore = createStore<ConfirmState>({ request: null })
export const useConfirm = createHook(confirmStore)

/** Ask before an action that can't be taken back from where it was started. A second request answers the first with no. */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  confirmStore.get().request?.answer(false)
  return new Promise((resolve) => {
    const answer = (confirmed: boolean) => {
      if (confirmStore.get().request?.answer === answer) confirmStore.set({ request: null })
      resolve(confirmed)
    }
    confirmStore.set({ request: { ...request, answer } })
  })
}

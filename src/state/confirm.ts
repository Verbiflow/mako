import { createHook, createStore } from "@/state/store"

export interface ConfirmRequest {
  title: string
  body: string
  /** The confirming button's label: the action itself, never "OK". */
  confirm: string
  /** Negative for an action that deletes something. */
  tone?: "negative" | "default"
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

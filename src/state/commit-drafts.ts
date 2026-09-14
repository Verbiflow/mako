import { createHook, createStore } from "./store"
import { git } from "./git"
import { prefsStore } from "./prefs"
import { currentCommitModel, refreshCommitModel } from "./commit-model"
import type { CommitAnalysisMode, CommitGenerationResult } from "@/lib/types"

interface CommitDraft {
  mode: CommitAnalysisMode
  text: string
  revision: number
  requestId: string | null
  suggestion: CommitGenerationResult | null
  result: CommitGenerationResult | null
  error: string | null
}
const empty: CommitDraft = {
  mode: "fast",
  text: "",
  revision: 0,
  requestId: null,
  suggestion: null,
  result: null,
  error: null,
}
const drafts = createStore<{ entries: Record<string, CommitDraft> }>({
  entries: {},
})
const useDrafts = createHook(drafts)
export const useCommitDraft = (cwd: string) =>
  useDrafts((state) => state.entries[cwd] ?? empty)
const current = (cwd: string) => drafts.get().entries[cwd] ?? empty
const update = (cwd: string, patch: Partial<CommitDraft>) =>
  drafts.set((state) => ({
    entries: { ...state.entries, [cwd]: { ...current(cwd), ...patch } },
  }))

export const commitDrafts = {
  setMode(cwd: string, mode: CommitAnalysisMode) {
    if (!current(cwd).requestId) update(cwd, { mode })
  },
  edit(cwd: string, text: string) {
    update(cwd, { text, revision: current(cwd).revision + 1 })
  },
  async generate(cwd: string) {
    const before = current(cwd)
    if (before.requestId) return
    const requestId = crypto.randomUUID()
    update(cwd, { requestId, suggestion: null, error: null })
    try {
      const { model } = await currentCommitModel()
      const result = await git.generateMessage({
        cwd,
        requestId,
        model,
        mode: before.mode,
        prompt: prefsStore.get().commitPrompt,
      })
      const after = current(cwd)
      if (after.requestId !== requestId) return
      if (after.revision !== before.revision || before.text.trim())
        update(cwd, { suggestion: result })
      else
        update(cwd, {
          text: result.message,
          revision: after.revision + 1,
          result,
        })
    } catch (error) {
      // A failed draft is the moment the connection is most likely to have
      // gone; the toolbar re-reads it so Reconnect replaces Generate.
      void refreshCommitModel()
      if (current(cwd).requestId === requestId)
        update(cwd, {
          error:
            error instanceof Error
              ? error.message
              : "Commit message was not generated. Try again.",
        })
    } finally {
      if (current(cwd).requestId === requestId) update(cwd, { requestId: null })
    }
  },
  async cancel(cwd: string) {
    const requestId = current(cwd).requestId
    if (!requestId) return
    try {
      await git.cancelGeneration(requestId)
      if (current(cwd).requestId === requestId)
        update(cwd, { requestId: null, error: null })
    } catch (error) {
      update(cwd, {
        error:
          error instanceof Error
            ? error.message
            : "Cancellation failed. Try again.",
      })
    }
  },
  accept(cwd: string) {
    const draft = current(cwd)
    if (draft.suggestion)
      update(cwd, {
        text: draft.suggestion.message,
        result: draft.suggestion,
        suggestion: null,
        revision: draft.revision + 1,
      })
  },
  dismiss(cwd: string) {
    update(cwd, { suggestion: null })
  },
  clearError(cwd: string) {
    update(cwd, { error: null })
  },
  committed(cwd: string, revision: number) {
    if (current(cwd).revision === revision)
      update(cwd, { ...empty, mode: current(cwd).mode, revision: revision + 1 })
  },
}

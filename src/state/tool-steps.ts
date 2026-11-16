import type { ToolSteps } from "@mako/host/contracts/tool-steps"
import { createHook, createStore } from "@/state/store"

/**
 * Each conversation's running `mako-computer` `js` call's steps so far, as its host sends them (`tool-steps`): the
 * whole state each time, at most four a second, replacing what was there, and gone once the call answers.
 */
export const toolStepsStore = createStore<{ running: Readonly<Record<string, ToolSteps>> }>({ running: {} })
export const useToolSteps = createHook(toolStepsStore)

export function toolStepped(conversationId: string, steps: ToolSteps | null): void {
  const { [conversationId]: _was, ...rest } = toolStepsStore.get().running
  if (!steps && !_was) return
  toolStepsStore.set({ running: steps ? { ...rest, [conversationId]: steps } : rest })
}

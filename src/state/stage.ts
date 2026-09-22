import { createHook, createStore } from "@/state/store"
import { prefsStore, setPref } from "@/state/prefs"
import { tabsStore } from "@/state/tabs"

/**
 * What the stage is showing in the right sidebar, per open tab.
 *
 * One companion at a time: every real workflow here is "work, and watch one
 * thing" — the diff, the preview, a shell. Holding it as a single id keeps
 * persistence, focus, and resizing trivial, and upgrading to several later
 * is a data change, not an architecture change.
 *
 * "beside" splits the stage into two cards; "over" lets the sidebar cover
 * the workbench, which stays mounted so transcript scroll and open tabs survive.
 */
export interface TabStage {
  companion: string | null
  dock: string | null
  dockExpanded?: boolean
  presentation: "beside" | "over"
}

interface StageState {
  byTab: Record<string, TabStage>
}

const CLOSED: TabStage = {
  companion: null,
  dock: null,
  presentation: "beside",
}

export const stageStore = createStore<StageState>({ byTab: {} })
export const useStage = createHook(stageStore)

export function stageOf(tabId: string): TabStage {
  return stageStore.get().byTab[tabId] ?? CLOSED
}

function write(tabId: string, next: TabStage) {
  stageStore.set((state) => ({ byTab: { ...state.byTab, [tabId]: next } }))
}

function activeTab(): string {
  return tabsStore.get().activeId
}

export const stage = {
  open(
    surfaceId: string,
    options: { presentation?: "beside" | "over"; remember?: boolean } = {}
  ) {
    const tabId = activeTab()
    if (!tabId) return
    write(tabId, {
      ...stageOf(tabId),
      companion: surfaceId,
      presentation: options.presentation ?? "beside",
    })
    if (options.remember !== false) setPref("lastCompanion", surfaceId)
  },

  close() {
    const tabId = activeTab()
    if (!tabId) return
    write(tabId, {
      ...stageOf(tabId),
      companion: null,
      presentation: "beside",
    })
  },

  toggle(surfaceId: string, options: { remember?: boolean } = {}) {
    const tabId = activeTab()
    if (!tabId) return
    if (stageOf(tabId).companion === surfaceId) stage.close()
    else stage.open(surfaceId, options)
  },

  toggleDock(surfaceId: string) {
    const tabId = activeTab()
    if (!tabId) return
    const current = stageOf(tabId)
    write(tabId, {
      ...current,
      dock: current.dock === surfaceId ? null : surfaceId,
    })
  },

  toggleDockExpanded() {
    const tabId = activeTab()
    if (!tabId) return
    const current = stageOf(tabId)
    write(tabId, { ...current, dockExpanded: !current.dockExpanded })
  },

  /**
   * Hide the right sidebar, or bring back its last section.
   * Rebooting starts every tab closed, so the pref is the only memory this
   * needs across launches — tab ids themselves do not survive a restart.
   */
  toggleCompanion() {
    const tabId = activeTab()
    if (!tabId) return
    if (stageOf(tabId).companion) stage.close()
    else stage.open(prefsStore.get().lastCompanion ?? "changes")
  },

  /** Uncover the chat without closing the companion. */
  showChat() {
    const tabId = activeTab()
    if (!tabId) return
    const current = stageOf(tabId)
    if (current.presentation === "over") write(tabId, { ...current, presentation: "beside" })
  },

  /** A closed tab must not leave its stage entry behind. */
  drop(tabId: string) {
    stageStore.set((state) => {
      if (!(tabId in state.byTab)) return {}
      const byTab = { ...state.byTab }
      delete byTab[tabId]
      return { byTab }
    })
  },
}

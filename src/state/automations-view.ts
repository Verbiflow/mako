import type { AutomationDefinitionInput } from "@mako/host/contracts/automations"
import { automations, automationsStore, automationView } from "@/state/automations"
import { automationsPane, inboxViewStore } from "@/state/inbox-view"
import { setPref } from "@/state/prefs"
import { createHook, createStore } from "@/state/store"
import { stage } from "@/state/stage"
import { viewer } from "@/state/viewer"

/**
 * Where Automations stands while it covers the conversation: the list (with its filter and search), one automation
 * (its runs and proposals), the starting points for a new one, or the editor. Each is a page of the one pane; Escape
 * goes back a page, and from the list back to the conversation.
 */
export type AutomationsFilter = "all" | "scheduled" | "needs" | "paused"

/** Where an editor's definition came from, which its heading says. */
export type DraftSource = "blank" | "template" | "thread" | "duplicate" | "existing"

export type AutomationsRoute =
  | { kind: "list" }
  | { kind: "detail"; project: string; id: string }
  | { kind: "new"; project?: string }
  | { kind: "edit"; project: string; id?: string; seed: Partial<AutomationDefinitionInput>; source: DraftSource; from?: string }

interface AutomationsViewState {
  route: AutomationsRoute
  filter: AutomationsFilter
  query: string
  /** The row the keyboard was on, so coming back to the list lands there. */
  focused?: string
}

export const automationsViewStore = createStore<AutomationsViewState>({ route: { kind: "list" }, filter: "all", query: "" })
export const useAutomationsView = createHook(automationsViewStore)

export function rowKey(project: string, id: string): string {
  return `${project}#${id}`
}

/** Automations over the conversation, on `route` (the list by default), read fresh. */
export function openAutomations(route: AutomationsRoute = { kind: "list" }): void {
  viewer.showAgent()
  stage.showChat()
  automationsViewStore.set({ route })
  automationsPane.open()
  void automations.load(true)
  // What failed until now is read: the Inbox stops counting it.
  setPref("automationsSeenAt", Date.now())
}

export function closeAutomations(): void {
  automationsPane.close()
}

export function toggleAutomations(): void {
  if (inboxViewStore.get().automations) closeAutomations()
  else openAutomations()
}

export function goAutomations(route: AutomationsRoute): void {
  automationsViewStore.set({ route })
}

/** One automation's page. */
export function showAutomation(project: string, id: string): void {
  automationsViewStore.set({ focused: rowKey(project, id) })
  openAutomations({ kind: "detail", project, id })
}

/** The editor on an automation as it stands. */
export function editAutomation(project: string, id: string): void {
  const view = automationView(automationsStore.get(), project, id)
  if (!view) return
  const route: AutomationsRoute = { kind: "edit", project, id, seed: view.definition, source: "existing" }
  if (inboxViewStore.get().automations) goAutomations(route)
  else openAutomations(route)
}

/** The editor on a copy, named and keyed as a copy, off. */
export function duplicateAutomation(project: string, id: string): void {
  const view = automationView(automationsStore.get(), project, id)
  if (!view) return
  goAutomations({ kind: "edit", project, seed: { ...view.definition, id: `${view.definition.id}-copy`.slice(0, 80), name: `${view.definition.name} copy`.slice(0, 120) }, source: "duplicate", from: view.definition.name })
}

/** "Make this an automation": the editor on what the Thread's first prompt and start make. */
export async function automationFromThread(conversationId: string, title?: string): Promise<void> {
  const draft = await automations.draft(conversationId)
  if (!draft) return
  openAutomations({ kind: "edit", project: draft.project, seed: draft.definition, source: "thread", ...(title && { from: title }) })
}

/** Back a page: the editor to where it was opened from, a page to the list, the list to the conversation. */
export function automationsBack(): void {
  const { route } = automationsViewStore.get()
  if (route.kind === "edit" && route.id) return goAutomations({ kind: "detail", project: route.project, id: route.id })
  if (route.kind === "edit" && route.source !== "thread") return goAutomations({ kind: "new", project: route.project })
  if (route.kind !== "list") return goAutomations({ kind: "list" })
  closeAutomations()
}

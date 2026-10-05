import { createHook, createStore } from "./store"
import { utilityModels } from "./model-runtime"
import { prefsStore, setPref } from "./prefs"
import { UTILITY_AUTOMATIC, type UtilityModelSettings } from "@/lib/types"
import { utilityModelName } from "../../electron/contracts/utility-work"

/**
 * Which model drafts commits, and whether it can.
 *
 * The host decides, for every window (`UtilityWork`): one of the person's
 * API connections, Automatic being the first. A connection chosen in
 * Settings is used while it's there and is otherwise `disconnected` with the
 * host's reason, so the toolbar offers Settings instead of a Generate that
 * cannot work. Windows once kept their own choice in the `commitModel`
 * preference; the first read hands it to the host.
 */
export type CommitModelStatus =
  | { kind: "unknown" }
  | { kind: "connected" }
  | { kind: "disconnected"; reason: string }

export interface ResolvedCommitModel {
  /** The model a draft would run with, or nothing when none can. */
  model: string | undefined
  /** That model and who runs it, as a person reads them. */
  label: string | undefined
  status: CommitModelStatus
}

const snapshot = createStore<{ settings: UtilityModelSettings | null; error: string | null }>({
  settings: null,
  error: null,
})
const useSnapshot = createHook(snapshot)
let inflight: Promise<void> | null = null

export function refreshCommitModel(): Promise<void> {
  if (inflight) return inflight
  inflight = Promise.resolve()
    .then(() => utilityModels.settings())
    .then(adoptWindowChoice)
    .then((settings) => snapshot.set({ settings, error: null }))
    .catch((caught) => snapshot.set({ settings: null, error: caught instanceof Error ? caught.message : "Models could not be loaded." }))
    .finally(() => {
      inflight = null
    })
  return inflight
}

async function adoptWindowChoice(settings: UtilityModelSettings): Promise<UtilityModelSettings> {
  const pref = prefsStore.get().commitModel
  if (!pref) return settings
  setPref("commitModel", undefined)
  const known = settings.work?.commit.options.some((option) => option.id === pref)
  if (pref === "current" || pref === UTILITY_AUTOMATIC || settings.work?.commit.choice !== UTILITY_AUTOMATIC || !known) return settings
  await utilityModels.choose("commit", pref)
  return utilityModels.settings()
}

export function resolveCommitModel(settings: UtilityModelSettings | null): ResolvedCommitModel {
  const state = settings?.work?.commit
  if (!state) return { model: undefined, label: undefined, status: { kind: "unknown" } }
  if (state.resolved)
    return { model: state.resolved.id, label: utilityModelName(state.resolved), status: { kind: "connected" } }
  if (state.choice !== UTILITY_AUTOMATIC)
    return { model: state.choice, label: undefined, status: { kind: "disconnected", reason: state.reason ?? "This model isn't available now." } }
  return { model: undefined, label: undefined, status: { kind: "unknown" } }
}

export const useResolvedCommitModel = () =>
  useSnapshot((state) => resolveCommitModel(state.settings))

/** The host's drafting settings and why they couldn't be read, for Settings › Git. */
export const useCommitModelSettings = () => useSnapshot((state) => state)

/** Choose what drafts commit messages, for every window; the snapshot follows. */
export async function chooseCommitModel(choice: string): Promise<void> {
  try {
    await utilityModels.choose("commit", choice)
    await inflight
    snapshot.set({ settings: await utilityModels.settings(), error: null })
  } catch (caught) {
    snapshot.set({ error: caught instanceof Error ? caught.message : "The choice could not be saved. Try again." })
  }
}

/**
 * The model a draft runs with right now, for callers outside React: the
 * command palette, the pull-request composer, the draft store. Loads the
 * host's choice once if nothing has asked for it yet.
 */
export async function currentCommitModel(): Promise<ResolvedCommitModel> {
  if (!snapshot.get().settings) await refreshCommitModel()
  return resolveCommitModel(snapshot.get().settings)
}

import { createHook, createStore } from "./store"
import { utilityModels } from "./model-runtime"
import { prefsStore } from "./prefs"
import type { UtilityModelSettings } from "@/lib/types"

/**
 * Which model drafts commits, and whether it can.
 *
 * The connection and the choice live apart: keys sit in the per-user store
 * (`~/.mako/utility-models`, shared by the installed app, `npm run dev` and
 * every profile), while the `commitModel` preference is this renderer's own
 * storage. Connecting in one window's Settings therefore left every other
 * window reading "Connect model" over a perfectly good connection, and a key
 * removed elsewhere, a locked keychain, or a connection swapped for another
 * model left a preference naming a model nobody could run — which the box
 * learned only by failing a draft and printing the host's exception.
 *
 * So the resolution is: the preference when it names a connected model;
 * otherwise the first connection the host can open, which is the only
 * sensible reading of one connected provider and no explicit choice. A
 * preference that names a model no connection covers is `disconnected` with
 * the reason, and the toolbar offers to reconnect instead of a Generate that
 * cannot work.
 */
export type CommitModelStatus =
  | { kind: "unknown" }
  | { kind: "connected" }
  | { kind: "disconnected"; reason: string }

export interface ResolvedCommitModel {
  /** The model id a draft would run with, or nothing when none is connected. */
  model: string | undefined
  status: CommitModelStatus
  /** Whether `model` came from the preference or from the connection list. */
  source: "preference" | "connection" | "none"
}

const snapshot = createStore<{ settings: UtilityModelSettings | null }>({
  settings: null,
})
const useSnapshot = createHook(snapshot)
let inflight: Promise<void> | null = null

export function refreshCommitModel(): Promise<void> {
  if (inflight) return inflight
  inflight = Promise.resolve()
    .then(() => utilityModels.settings())
    .then((settings) => snapshot.set({ settings }))
    .catch(() => snapshot.set({ settings: null }))
    .finally(() => {
      inflight = null
    })
  return inflight
}

const explicit = (pref: string | undefined) =>
  pref && pref !== "current" && pref !== "auto" ? pref : undefined

export function commitModelStatus(
  settings: UtilityModelSettings | null,
  model: string | undefined
): CommitModelStatus {
  if (!settings || !model) return { kind: "unknown" }
  const providerId = model.slice(0, model.indexOf("/"))
  const issue = settings.issues.find(({ provider }) => provider === providerId)
  if (issue) return { kind: "disconnected", reason: issue.message }
  const connected = settings.connections.some(
    (connection) => `${connection.provider}/${connection.model}` === model
  )
  if (connected) return { kind: "connected" }
  const provider = settings.providers.find(({ id }) => id === providerId)
  return {
    kind: "disconnected",
    reason: provider
      ? `${provider.name} is no longer connected in Settings > Commit messages.`
      : "This model is no longer connected in Settings > Commit messages.",
  }
}

export function resolveCommitModel(
  settings: UtilityModelSettings | null,
  pref: string | undefined
): ResolvedCommitModel {
  const chosen = explicit(pref)
  if (chosen)
    return { model: chosen, status: commitModelStatus(settings, chosen), source: "preference" }
  if (!settings) return { model: undefined, status: { kind: "unknown" }, source: "none" }
  const usable = settings.connections.find(
    (connection) => !settings.issues.some(({ provider }) => provider === connection.provider)
  )
  if (!usable) return { model: undefined, status: { kind: "unknown" }, source: "none" }
  return {
    model: `${usable.provider}/${usable.model}`,
    status: { kind: "connected" },
    source: "connection",
  }
}

export const useResolvedCommitModel = (pref: string | undefined) =>
  useSnapshot((state) => resolveCommitModel(state.settings, pref))

/**
 * The model a draft should run with right now, for callers outside React:
 * the command palette, the pull-request composer, the draft store. Loads the
 * connections once if nothing has asked for them yet.
 */
export async function currentCommitModel(): Promise<ResolvedCommitModel> {
  if (!snapshot.get().settings) await refreshCommitModel()
  return resolveCommitModel(snapshot.get().settings, prefsStore.get().commitModel)
}

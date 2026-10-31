import { fuzzy } from "@/lib/fuzzy"
import type { HarnessModel } from "@/lib/types"
import { modelKey } from "@/state/prefs"

/**
 * A harness's models in a picker's order: the person's favourites first, the rest as the harness lists them; with a
 * query, the ones that match it, best first, by name, id, alias or description. The desk's picker and the phone's
 * sheet list them alike.
 */
export function rankModels(
  models: HarnessModel[],
  query: string,
  favorites: string[],
  harness: string
): HarnessModel[] {
  const term = query.trim()
  if (!term) {
    const order = new Map(favorites.map((key, index) => [key, index]))
    return [...models].sort((left, right) => {
      const leftOrder = order.get(modelKey(harness, left.id))
      const rightOrder = order.get(modelKey(harness, right.id))
      if (leftOrder === undefined && rightOrder === undefined) return 0
      if (leftOrder === undefined) return 1
      if (rightOrder === undefined) return -1
      return leftOrder - rightOrder
    })
  }
  return models
    .flatMap((model) => {
      const match = fuzzy(
        term,
        `${model.label} ${model.id} ${model.launchId ?? ""} ${(model.aliases ?? []).join(" ")} ${model.description ?? ""}`
      )
      return match ? [{ model, score: match.score }] : []
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.model)
}

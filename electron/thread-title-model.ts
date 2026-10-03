import { TitleModelError, type TitleModel } from "./thread-titles.js"
import type { UtilityModelStore } from "./utility-model-store.js"
import { completeUtilityText, UtilityModelError, utilityLanguageModel, utilityProviders } from "./utility-models.js"

/** Enough for a reasoning model's low effort and a title; a title needs a few dozen. */
const TITLE_OUTPUT_TOKENS = 512

/**
 * The model chosen in Settings, through the same AI SDK connection commit
 * drafting uses: an API key or a local endpoint, never a coding agent's
 * account. A choice whose connection went away or now names another model
 * is unavailable; no other connection stands in for it.
 */
export async function resolveTitleModel(models: UtilityModelStore): Promise<TitleModel> {
  const chosen = await models.titleModel()
  if (!chosen) return { kind: "off" }
  const provider = utilityProviders.find(({ id }) => chosen.startsWith(`${id}/`))
  let connection: Awaited<ReturnType<UtilityModelStore["load"]>>
  try {
    connection = provider ? await models.load(provider.id) : null
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) }
  }
  if (!connection || `${connection.provider}/${connection.model}` !== chosen)
    return { kind: "unavailable", reason: `${chosen} is no longer connected. Choose a model for Thread titles in Settings > Conversation.` }
  const model = utilityLanguageModel(connection, connection.apiKey)
  return {
    kind: "ready",
    id: chosen,
    complete: async (instructions, prompt, signal) => {
      try {
        return await completeUtilityText(model, instructions, prompt, signal, TITLE_OUTPUT_TOKENS)
      } catch (error) {
        if (!(error instanceof UtilityModelError)) throw error
        throw new TitleModelError(error.kind, error.message, error.kind === "auth" || error.kind === "rate-limit")
      }
    },
  }
}

import { TitleModelError, type TitleModel } from "./thread-titles.js"
import { UtilityModelError } from "./utility-model-error.js"
import type { UtilityWork } from "./utility-work.js"

/** Enough for a reasoning model's low effort and a title; a title needs a few dozen. */
const TITLE_OUTPUT_TOKENS = 512

/**
 * The model that names Threads, as `UtilityWork` decides for every small
 * task: by default the first signed-in agent's light model, on the person's
 * own account; or the model chosen in Settings › Conversation.
 */
export async function resolveTitleModel(work: UtilityWork): Promise<TitleModel> {
  const resolved = await work.resolve("title")
  if (resolved.kind !== "ready") return resolved
  const { model } = resolved
  return {
    kind: "ready",
    id: model.id,
    complete: async (instructions, prompt, signal) => {
      try {
        return await model.complete({ instructions, prompt, maxOutputTokens: TITLE_OUTPUT_TOKENS, reasoning: "low" }, signal)
      } catch (error) {
        if (!(error instanceof UtilityModelError)) throw error
        throw new TitleModelError(error.kind, error.message, error.kind === "auth" || error.kind === "rate-limit")
      }
    },
  }
}

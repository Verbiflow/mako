import { z } from "zod"
import { modelByIdentity, type SessionSettings } from "@mako/sessions/settings"
import { codexServiceTier } from "@mako/sessions/model-catalog"
import type { HarnessModelCatalog } from "@mako/sessions/model-catalog"

/** Deliberately project only non-secret configuration fields. */
export const CodexConfigSchema = z.object({
  config: z.object({
    model: z.string().nullish(),
    model_reasoning_effort: z.string().nullish(),
    service_tier: z.string().nullish(),
  }),
})

export function codexConfiguredSettings(
  catalog: HarnessModelCatalog,
  response: z.infer<typeof CodexConfigSchema>
): SessionSettings {
  const model = response.config.model ?? catalog.defaultModel
  const row = modelByIdentity(catalog.models, model)
  const effortOption = row?.options.find(
    (option) => option.role === "reasoning"
  )
  const effort = response.config.model_reasoning_effort ?? effortOption?.current
  const options: NonNullable<SessionSettings["options"]> = {
    serviceTier: codexServiceTier(response.config.service_tier ?? "default"),
  }
  if (effort !== undefined) options.effort = effort
  return { model, options }
}

/** Codex accepts `default` as an explicit reset; omission retains the previous tier. */
export function codexWireSettings(settings?: SessionSettings) {
  const effort = z.string().optional().parse(settings?.options?.effort)
  const serviceTier = z
    .string()
    .optional()
    .parse(settings?.options?.serviceTier)
  return {
    model: settings?.model,
    effort,
    serviceTier:
      serviceTier === undefined ? undefined : codexServiceTier(serviceTier),
  }
}

type CodexInteractiveConfig = {
  "features.default_mode_request_user_input": true
  model_reasoning_effort?: string
}

/** Mako can answer native questions during ordinary interactive turns. */
export function codexInteractiveConfig(effort?: string) {
  const config: CodexInteractiveConfig = {
    "features.default_mode_request_user_input": true,
  }
  if (effort) config.model_reasoning_effort = effort
  return config
}

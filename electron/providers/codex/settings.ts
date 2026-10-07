import { z } from "zod"
import { modelByIdentity, type SessionSettings } from "@mako/sessions/settings"
import { codexServiceTier } from "@mako/sessions/model-catalog"
import type { HarnessModelCatalog } from "@mako/sessions/model-catalog"
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js"

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

/**
 * Codex's collaboration mode from the session's `plan` setting. Codex keeps
 * the mode for later turns and restores it on resume, so a known setting is
 * always sent — `default` included — and the session runs what Mako shows.
 * The mode takes precedence over the turn's model and effort, so it carries
 * them; `developer_instructions: null` keeps Codex's own instructions for
 * the mode. Approvals and sandbox are untouched: planning with full access
 * stays full access.
 */
export function codexCollaborationMode(
  settings: SessionSettings | undefined,
  sessionModel: string | undefined
): Pick<TurnStartParams, "collaborationMode"> {
  const plan = z.boolean().optional().parse(settings?.options?.plan)
  if (plan === undefined) return {}
  const model = settings?.model ?? sessionModel
  if (!model) {
    if (!plan) return {}
    throw new Error("Codex needs a model to plan with. Pick one in the model menu and send again.")
  }
  const { effort } = codexWireSettings(settings)
  return {
    collaborationMode: {
      mode: plan ? "plan" : "default",
      settings: { model, reasoning_effort: effort ?? null, developer_instructions: null },
    },
  }
}

/**
 * What Mako's client offers the app-server at `initialize`. Codex 0.159.3
 * refuses `turn/start.collaborationMode`, its plan mode, without
 * `experimentalApi`.
 */
export const CODEX_CLIENT_CAPABILITIES = { experimentalApi: true, requestAttestation: false } as const

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

import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import type { SessionSettings } from "@mako/sessions/settings"
import { normalizeAcpOptions } from "@mako/sessions/model-catalog"
import { z } from "zod"
import { accessTierOfModeId } from "./contracts/access.js"

export function resolveAcpConfigValue(
  option: SessionConfigOption,
  requested: string
): string {
  if (option.type !== "select") return requested
  const values = option.options.flatMap((candidate) =>
    "value" in candidate ? [candidate] : candidate.options
  )
  return (
    values.find(
      (candidate) =>
        candidate.value === requested || candidate.name === requested
    )?.value ?? requested
  )
}

export function acpObservedSettings(
  options: SessionConfigOption[],
  model?: string
): SessionSettings {
  const settings: SessionSettings = { model, options: {} }
  for (const option of normalizeAcpOptions(options)) {
    if (option.current === undefined) continue
    if (option.id === "model" && option.kind === "select")
      settings.model = option.current
    else settings.options![option.id] = option.current
  }
  return settings
}

interface ApplyAcpSettingsInput {
  settings: SessionSettings
  observed: SessionSettings
  options: SessionConfigOption[]
  launchOptionIds?: readonly string[]
  setOption(
    option: SessionConfigOption,
    value: string | boolean
  ): Promise<SessionConfigOption[]>
  setModel(model: string): Promise<void>
}

/** Apply sequentially: changing a model can replace every other option's choices. */
export async function applyAcpSettings(input: ApplyAcpSettingsInput): Promise<{
  options: SessionConfigOption[]
  settings: SessionSettings
}> {
  let options = input.options
  const model = input.settings.model ?? input.observed.model
  if (input.settings.model && input.settings.model !== input.observed.model) {
    const entry = normalizeAcpOptions(options).find(
      (option) => option.id === "model"
    )
    const wire = options.find((option) => option.id === entry?.wireId)
    if (wire)
      options = await input.setOption(
        wire,
        resolveAcpConfigValue(wire, input.settings.model)
      )
    else await input.setModel(input.settings.model)
  }
  const applied = { ...input.observed.options }
  for (const [id, value] of Object.entries(input.settings.options ?? {})) {
    // Normalized access ids go through provider mode selection, not through
    // the native config-option vocabulary.
    const modeId = z.string().safeParse(value)
    if (modeId.success && accessTierOfModeId(modeId.data)) continue
    const normalized = normalizeAcpOptions(options).find(
      (option) => option.id === id
    )
    const wire = options.find((option) => option.id === normalized?.wireId)
    if (
      normalized?.current === value ||
      (input.observed.model === model && applied[id] === value)
    )
      continue
    if (wire) {
      options = await input.setOption(wire, value)
    } else if (!input.launchOptionIds?.includes(id)) {
      throw new Error(
        `This provider cannot change ${normalized?.label ?? id} in the running session.`
      )
    }
    applied[id] = value
  }
  const observed = acpObservedSettings(options, model)
  return {
    options,
    settings: {
      model: observed.model,
      options: { ...applied, ...observed.options },
    },
  }
}

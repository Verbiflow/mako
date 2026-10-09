import { capabilityText, LIVE_CAPABILITY_KEYS, LIVE_CAPABILITY_LABELS, type Capability } from "../../electron/contracts/harness-capabilities"
import { HARNESS_USAGE_KEYS, HARNESS_USAGE_LABELS } from "../../electron/contracts/harness-usage"
import { DECLARATION_SHOWS } from "../../electron/contracts/harness-unique"
import type { HarnessDescriptor } from "@/lib/types"

export type Standing = "works" | "own" | "lacks" | "gap"

export interface CapabilityRow {
  key: string
  label: string
  standing: Standing
  /** Where it shows when it works; otherwise the harness's reason. */
  text: string
  /** How it works underneath, for whoever is checking a declaration. */
  detail?: string
}

export interface CapabilityGroup {
  title: string
  rows: CapabilityRow[]
}

function standing(capability: Capability): Standing {
  if (capability.state === "implemented") return "works"
  if (capability.state === "absent") return capability.by === "mako" ? "gap" : "lacks"
  return "own"
}

function row(key: string, label: string, capability: Capability, shows: string): CapabilityRow {
  const state = standing(capability)
  return state === "works"
    ? { key, label, standing: state, text: shows, detail: capabilityText(capability) }
    : { key, label, standing: state, text: capabilityText(capability) }
}

/** Every declaration the window reads for one harness, grouped as Settings shows them. */
export function capabilityGroups(descriptor: HarnessDescriptor): CapabilityGroup[] {
  const { capabilities, usage, artifacts, unique } = descriptor
  const questions = capabilities.questions
  const conversation = [
    ...LIVE_CAPABILITY_KEYS.map((key) => row(key, LIVE_CAPABILITY_LABELS[key], capabilities[key],
      key === "questions" && questions.state === "implemented" && questions.asks === "session"
        ? "Question cards above the composer, kept after the turn and through a restart."
        : DECLARATION_SHOWS[`capabilities.${key}`])),
    row("artifacts", "Artifact previews", artifacts, artifacts.state === "implemented"
      ? `Interactive previews in the file viewer, for ${artifacts.name} files (${artifacts.files.join(", ")}).`
      : DECLARATION_SHOWS.artifacts),
  ]
  const reported = HARNESS_USAGE_KEYS.filter((key) => key !== "contextBreakdown")
    .map((key) => row(`usage.${key}`, HARNESS_USAGE_LABELS[key], usage[key], DECLARATION_SHOWS[`usage.${key}`]))
  const own = unique.map(({ name, native, mako }) => {
    const state = standing(mako)
    return { key: `unique.${name}`, label: name, standing: state, text: capabilityText(mako), detail: native }
  })
  return [
    ...(own.length ? [{ title: `Only in ${descriptor.displayName}`, rows: own }] : []),
    { title: "In conversations", rows: conversation },
    { title: "Usage", rows: reported },
  ]
}

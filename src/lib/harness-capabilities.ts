import { capabilityText, LIVE_CAPABILITY_KEYS, LIVE_CAPABILITY_LABELS, type Capability } from "@mako/host/contracts/harness-capabilities"
import { DECLARATION_SHOWS, HARNESS_FEATURE_KEYS, HARNESS_FEATURES, type NativeFeature } from "@mako/host/contracts/harness-features"
import { HARNESS_USAGE_KEYS, HARNESS_USAGE_LABELS } from "@mako/host/contracts/harness-usage"
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
  /** What the harness itself calls it, where Mako's name differs. */
  native?: NativeFeature
}

export interface CapabilityGroup {
  title: string
  rows: CapabilityRow[]
  /** The group of what only this harness has, among the harnesses Mako knows. */
  only?: boolean
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

/** Each declaration's capability, by row key, as one descriptor makes them. */
function declarations(descriptor: HarnessDescriptor): Map<string, Capability> {
  const { capabilities, usage, artifacts, features } = descriptor
  return new Map([
    ...LIVE_CAPABILITY_KEYS.map((key) => [key, capabilities[key]] as const),
    ["artifacts", artifacts] as const,
    ...HARNESS_USAGE_KEYS.map((key) => [`usage.${key}`, usage[key]] as const),
    ...HARNESS_FEATURE_KEYS.map((key) => [`features.${key}`, features[key].mako] as const),
  ])
}

/** Whether a harness has a thing of its own, whether or not Mako drives it. Mako's own serves every harness. */
function hasOwn(capability: Capability): boolean {
  if (capability.state === "implemented") return !("through" in capability && capability.through === "mako")
  return capability.state !== "absent" || capability.by === "mako"
}

/**
 * Every declaration the window reads for one harness, grouped as Settings
 * shows them. A shared one only this harness has, among `all`, moves to the
 * group of its own, beside what its definition lists as unique.
 */
export function capabilityGroups(descriptor: HarnessDescriptor, all: readonly HarnessDescriptor[]): CapabilityGroup[] {
  const { capabilities, usage, artifacts, features, unique } = descriptor
  const questions = capabilities.questions
  const others = all.filter(({ provider }) => provider !== descriptor.provider).map(declarations)
  const mine = declarations(descriptor)
  const alone = (key: string) => {
    const declared = mine.get(key)
    return others.length > 0 && declared !== undefined && hasOwn(declared)
      && others.every((other) => { const theirs = other.get(key); return theirs === undefined || !hasOwn(theirs) })
  }
  const conversation = [
    ...LIVE_CAPABILITY_KEYS.map((key) => row(key, LIVE_CAPABILITY_LABELS[key], capabilities[key],
      key === "questions" && questions.state === "implemented" && questions.asks === "session"
        ? "Question cards above the composer, kept after the turn and through a restart."
        : DECLARATION_SHOWS[`capabilities.${key}`])),
    row("artifacts", "Artifact previews", artifacts, artifacts.state === "implemented"
      ? `Interactive previews in the file viewer, for ${artifacts.name} files (${artifacts.files.join(", ")}).`
      : DECLARATION_SHOWS.artifacts),
  ]
  const shared = HARNESS_FEATURE_KEYS.map((key): CapabilityRow => {
    const { native, mako } = features[key]
    const item: CapabilityRow = { key: `features.${key}`, label: HARNESS_FEATURES[key].name, standing: standing(mako), text: capabilityText(mako) }
    if (native) item.native = native
    return item
  })
  const reported = HARNESS_USAGE_KEYS.filter((key) => key !== "contextBreakdown")
    .map((key) => row(`usage.${key}`, HARNESS_USAGE_LABELS[key], usage[key], DECLARATION_SHOWS[`usage.${key}`]))
  const listed = unique.map(({ name, native, mako }): CapabilityRow =>
    ({ key: `unique.${name}`, label: name, standing: standing(mako), text: capabilityText(mako), detail: native }))
  const groups = [
    { title: "In conversations", rows: conversation },
    { title: "Features", rows: shared },
    { title: "Usage", rows: reported },
  ]
  const own = [...groups.flatMap((group) => group.rows.filter((item) => alone(item.key))), ...listed]
  return [
    ...(own.length ? [{ title: `Only in ${descriptor.displayName}`, rows: own, only: true }] : []),
    ...groups.map((group) => ({ ...group, rows: group.rows.filter((item) => !alone(item.key)) })),
  ]
}

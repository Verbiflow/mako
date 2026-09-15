import type { HarnessDescriptor } from "@/lib/types"
import type { ThreadsState } from "@/state/thread-state"

type WithDescriptors = Pick<ThreadsState, "descriptors">

/** One provider's description, when the host knows it. */
export function descriptorFor(
  state: WithDescriptors,
  harness: string | null | undefined
): HarnessDescriptor | undefined {
  if (!harness) return undefined
  return state.descriptors.find((item) => item.provider === harness)
}

/**
 * The lists below are cached on the descriptors array so a selector returns
 * the same reference between store changes — a fresh array per call would
 * wake every subscriber on every token.
 */
let derived: {
  source: HarnessDescriptor[]
  live: string[]
  resumable: string[]
  targets: string[]
} | null = null

function lists(descriptors: HarnessDescriptor[]): {
  live: string[]
  resumable: string[]
  targets: string[]
} {
  if (derived?.source === descriptors) return derived
  derived = {
    source: descriptors,
    live: [],
    resumable: [],
    targets: [],
  }
  for (const item of descriptors) {
    if (item.live) derived.live.push(item.provider)
    if (item.resumable) derived.resumable.push(item.provider)
    if (item.live || item.resumable) derived.targets.push(item.provider)
  }
  return derived
}

/** Providers an interactive transport can drive right now. */
export function liveHarnesses(state: WithDescriptors): string[] {
  return lists(state.descriptors).live
}

/** Providers whose sessions a headless native run can continue. */
export function resumableHarnesses(state: WithDescriptors): string[] {
  return lists(state.descriptors).resumable
}

/** Providers a conversation can be continued on, either way. */
export function continueTargets(state: WithDescriptors): string[] {
  return lists(state.descriptors).targets
}

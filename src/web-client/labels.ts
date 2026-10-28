import { harnessDescriptors } from "@/dev/harness-descriptors"
import type { HarnessDescriptor } from "@/lib/types"

/** A harness's name as Mako shows it everywhere ("Claude Code"), from the harness definitions. */
export function webHarnessLabel(harness: string): string {
  return harnessDescriptors.find((descriptor) => descriptor.provider === harness)?.displayName ?? harness
}

/** Every harness, in Mako's order. */
export const WEB_HARNESSES: readonly string[] = harnessDescriptors.map((descriptor) => descriptor.provider)

/**
 * Every harness as the host describes it on any Mac, each runnable: what the renderer reads for a harness's name, mark
 * and what it can do (steering, modes). Generated from the harness definitions (`npm run harness:descriptors`).
 */
export function webHarnessDescriptors(): HarnessDescriptor[] {
  return harnessDescriptors.map((descriptor) => ({ ...descriptor, live: true }))
}

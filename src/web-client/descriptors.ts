import { harnessDescriptors } from "@/dev/harness-descriptors"
import type { HarnessDescriptor } from "@/lib/types"

/**
 * Every harness as the host describes it on any Mac, each runnable: what the renderer reads for a harness's name, mark
 * and what it can do (steering, modes). Generated from the harness definitions (`npm run harness:descriptors`).
 */
export function webHarnessDescriptors(): HarnessDescriptor[] {
  return harnessDescriptors.map((descriptor) => ({ ...descriptor, live: true }))
}

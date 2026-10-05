import type { HarnessDescriptor } from "@/lib/types"
import { harnessDescriptors } from "./harness-descriptors"

/** Every harness the host installs, live and resumable as on a Mac with each signed in. */
export const fixtureHarnesses: HarnessDescriptor[] = harnessDescriptors.map((entry) => ({ ...entry, live: true, canResume: true }))

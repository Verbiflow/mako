import { readFileSync } from "node:fs"
import { CpuProfileSchema, loopSlices, type LoopSlice } from "@mako/host/base/loop-profile"

export { heldBy } from "@mako/host/base/loop-profile"

/** A `.cpuprofile` file's slices of at least `minMs`, read as the host reads its own (`loopSlices`). */
export function slices(path: string, minMs: number): LoopSlice[] {
  return loopSlices(CpuProfileSchema.parse(JSON.parse(readFileSync(path, "utf8"))), minMs)
}

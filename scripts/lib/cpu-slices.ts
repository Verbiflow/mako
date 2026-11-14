import { readFileSync } from "node:fs"
import { CpuProfileSchema, loopSlices, type LoopSlice } from "@mako/host/base/loop-profile"

export { heldBy } from "@mako/host/base/loop-profile"

/** A `.cpuprofile` file's slices of at least `minMs`, read as the host reads its own (`loopSlices`). */
export function slices(path: string, minMs: number): LoopSlice[] {
  return loopSlices(CpuProfileSchema.parse(JSON.parse(readFileSync(path, "utf8"))), minMs)
}

/**
 * Milliseconds a `.cpuprofile` file spent with a frame of `files` anywhere on the stack (a module's whole cost, what it
 * calls included), and the profile's whole sampled time, from `from` ms after it began (to leave out a warm-up).
 */
export function timeIn(path: string, files: readonly string[], from = 0) {
  const profile = CpuProfileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  const parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const hits = new Map<number, boolean>()
  const inFiles = (id: number): boolean => {
    const known = hits.get(id)
    if (known !== undefined) return known
    const node = byId.get(id)
    const own = node !== undefined && files.some((file) => node.callFrame.url.endsWith(file))
    const up = parent.get(id)
    const hit = own || (up !== undefined && inFiles(up))
    hits.set(id, hit)
    return hit
  }
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  let at = 0
  let ms = 0
  let ofMs = 0
  for (let index = 0; index < samples.length; index++) {
    const step = (deltas[index] ?? 0) / 1000
    at += step
    if (at < from) continue
    ofMs += step
    if (inFiles(samples[index]!)) ms += step
  }
  return { ms: Math.round(ms), ofMs: Math.round(ofMs) }
}

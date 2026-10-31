import { agentOrder, harnessesByRecency } from "@mako/host/contracts/agent-order"
import type { ThreadWorktrees } from "@mako/host/contracts/thread-worktrees"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { z } from "zod"
import { projectFolder, pathInside } from "@mako/host/contracts/worktree-paths"
import type { AccountListState } from "./account-list"
import type { Catalog, OfferedHarness } from "./start"

/**
 * Where a new Thread can run, from a phone: one of the account's Macs, by name, or the cloud. The phone itself runs
 * nothing, so "here" is never offered; a Mac that's off is listed, and can't be chosen.
 */
export type Place = { kind: "mac"; deviceId: string; name: string; quietSince?: string; usedAt: number } | { kind: "cloud" }

/** A place as the phone keeps it: a Mac by its device, or the cloud. */
export type PlaceKey = string
export const CLOUD_PLACE: PlaceKey = "cloud"

export function placeKey(place: Place): PlaceKey {
  return place.kind === "cloud" ? CLOUD_PLACE : place.deviceId
}

type ListParts = Pick<AccountListState, "rows" | "devices" | "quiet">

/** The account's Macs: devices that run Threads (not browsers), named. */
export function macCount(list: Pick<AccountListState, "devices">): number {
  let count = 0
  for (const device of list.devices.values()) if (device.kind === "desktop") count++
  return count
}

/**
 * Where a Thread can start: the account's Macs that are on, most recently worked on first, then those that are off,
 * then the cloud when the account has it.
 */
export function places(list: ListParts, cloud: boolean): Place[] {
  const used = new Map<string, number>()
  for (const row of list.rows) if (row.runsOn.kind === "device") used.set(row.runsOn.deviceId, Math.max(used.get(row.runsOn.deviceId) ?? 0, Date.parse(row.activityAt)))
  const macs: Array<Extract<Place, { kind: "mac" }>> = []
  for (const device of list.devices.values()) {
    if (device.kind !== "desktop") continue
    const mac: Extract<Place, { kind: "mac" }> = { kind: "mac", deviceId: device.id, name: device.name, usedAt: used.get(device.id) ?? 0 }
    const quietSince = list.quiet.get(device.id)
    if (quietSince) mac.quietSince = quietSince
    macs.push(mac)
  }
  macs.sort((left, right) => Number(left.quietSince !== undefined) - Number(right.quietSince !== undefined) || right.usedAt - left.usedAt)
  return cloud ? [...macs, { kind: "cloud" }] : macs
}

/** Whether a Thread can start there now: the cloud always can; a Mac while it's on. */
export function startable(place: Place): boolean {
  return place.kind === "cloud" || place.quietSince === undefined
}

/**
 * Where a new Thread starts unless the person picks: the place they last started from on this phone, while it can
 * still start one; else the Mac they worked on most recently, if it's on; else the cloud.
 */
export function defaultPlace(all: readonly Place[], last: PlaceKey | undefined): Place | undefined {
  const remembered = last ? all.find((place) => placeKey(place) === last && startable(place)) : undefined
  return remembered ?? all.find(startable)
}

/** A project a Thread can start in: a Mac's folder, by its own path, or a cloud repository's address. */
export interface StartProject {
  /** The folder on the Mac, or the repository's URL for the cloud. */
  id: string
  name: string
  usedAt: number
}

/**
 * A Mac's projects, read from the account's own list of its Sessions (each row carries its folder), the most recently
 * worked in first. A Session in one of Mako's worktrees counts for the project it was made from (`projectFolder`, the
 * desk's own mapping); one under the worktree root that no worktree claims any more is passed over.
 */
export function macProjects(rows: readonly ListedSession[], deviceId: string, worktrees: ThreadWorktrees | undefined): StartProject[] {
  const used = new Map<string, number>()
  for (const row of rows) {
    if (row.runsOn.kind !== "device" || row.runsOn.deviceId !== deviceId || !row.folder) continue
    const inWorktree = projectFolder(worktrees?.worktrees, row.folder)
    if (!inWorktree && worktrees && pathInside(worktrees.root, row.folder)) continue
    const folder = inWorktree ?? row.folder
    used.set(folder, Math.max(used.get(folder) ?? 0, Date.parse(row.activityAt)))
  }
  return [...used].sort(([, left], [, right]) => right - left).map(([folder, usedAt]) => ({ id: folder, name: folder.split("/").filter(Boolean).at(-1) ?? folder, usedAt }))
}

/**
 * The harnesses a Thread is offered with, in the order the desk offers them: the ones used most recently on the
 * account first, then the person's order, of those signed in there (`agentOrder`, the desk's own).
 */
export function harnessOrder(rows: readonly ListedSession[], signedIn: readonly string[], order: readonly string[]): string[] {
  return agentOrder({ signedIn, order, recent: harnessesByRecency(rows.map((row) => ({ harness: row.harness, updatedAt: row.activityAt }))) })
}

/** What a phone remembers of its starts, per place: the project and the harness and model last started there. */
const StartMemorySchema = z.object({
  place: z.string().optional(),
  loadouts: z.record(z.string(), z.object({ project: z.string().optional(), harness: z.string().optional(), model: z.string().optional() })).default({}),
})
export type StartMemory = z.infer<typeof StartMemorySchema>
const MEMORY_KEY = "mako:web:start"

export function readStartMemory(): StartMemory {
  try {
    return StartMemorySchema.parse(JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "{}"))
  } catch {
    return StartMemorySchema.parse({})
  }
}

/** A start, remembered: its place becomes the default, and its project and loadout the defaults there. */
export function rememberStart(place: PlaceKey, loadout: { project: string; harness: string; model: string | undefined }): void {
  const memory = readStartMemory()
  memory.place = place
  const kept: StartMemory["loadouts"][string] = { project: loadout.project, harness: loadout.harness }
  if (loadout.model) kept.model = loadout.model
  memory.loadouts[place] = kept
  localStorage.setItem(MEMORY_KEY, JSON.stringify(memory))
}

/** A place's harnesses, signed-in first, in the desk's own order (`agentOrder`: recent on the account, then the person's). */
export function orderedHarnesses(catalog: Catalog, rows: readonly ListedSession[]): OfferedHarness[] {
  const order = harnessOrder(rows, catalog.harnesses.filter((each) => each.available || each.pending).map((each) => each.harness), catalog.order)
  const rank = (harness: string) => {
    const at = order.indexOf(harness)
    return at === -1 ? order.length + catalog.order.indexOf(harness) : at
  }
  return [...catalog.harnesses].sort((left, right) => rank(left.harness) - rank(right.harness))
}


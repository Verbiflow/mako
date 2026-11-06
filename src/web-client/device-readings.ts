import { HEARD_FRESH_MS, type DeviceRuns } from "@mako/host/contracts/account-devices"
import type { AccountListState } from "./account-list"

/**
 * What the account's list says of its devices beyond their own records: the Threads each runs (its rows are
 * Sessions, folded by Thread; which are Fins the list doesn't say), and, only while the list is current, the account's
 * word on each: quiet since a time, or there.
 *
 * A device is there while it lists Sessions and the account doesn't call it quiet, the rule a Mac's connection is
 * read by (`macConnection`); that wins over a record whose `lastSeenAt` is only as new as its last read and was
 * written as the device joined. But a row is evidence only of when it was heard. A list painted from this browser's
 * cache, or one whose stream is being followed again, holds rows from before, which say nothing of now; so does a
 * live list that hasn't said anything for a while (a page asleep). The list's word counts while it's followed live
 * and was current within `HEARD_FRESH_MS` (each event, and each re-read of the devices while Settings shows, makes it
 * so); otherwise the counts stay, and each device's own record says how it stands.
 */
export interface DeviceReadings {
  runs: Map<string, DeviceRuns>
  /** When the account last heard from each quiet device: its own word, said only while the list is current. */
  quiet: ReadonlyMap<string, string>
  /** The devices that are there now: they list work, the account doesn't call them quiet, and the list is current. */
  heard: ReadonlySet<string>
}

export function deviceReadings(list: Pick<AccountListState, "rows" | "quiet" | "phase" | "asOf">, now: number): DeviceReadings {
  const threads = new Map<string, Set<string>>()
  for (const row of list.rows) {
    if (row.runsOn.kind !== "device") continue
    const there = threads.get(row.runsOn.deviceId) ?? new Set<string>()
    there.add(row.thread)
    threads.set(row.runsOn.deviceId, there)
  }
  const runs = new Map<string, DeviceRuns>([...threads].map(([device, there]) => [device, { threads: there.size, fins: 0 }]))
  const current = list.phase === "live" && list.asOf !== undefined && now - list.asOf <= HEARD_FRESH_MS
  if (!current) return { runs, quiet: new Map(), heard: new Set() }
  return { runs, quiet: list.quiet, heard: new Set([...threads.keys()].filter((device) => !list.quiet.has(device))) }
}

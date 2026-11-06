import type { DeviceRuns } from "@mako/host/contracts/account-devices"
import type { AccountListState } from "./account-list"

/**
 * What the account's list says of its devices beyond their own records, read fresh from the list each time it
 * changes: the Threads each runs (its rows are Sessions, folded by Thread; which are Fins the list doesn't say), and
 * which devices are there now. A device is there while it lists Sessions and the account doesn't call it quiet, the
 * rule a Mac's connection is read by (`macConnection`): the list is live, where a device's `lastSeenAt` is only as
 * new as the last time its record was read, and was written as it joined.
 */
export interface DeviceReadings {
  runs: Map<string, DeviceRuns>
  heard: Set<string>
}

export function deviceReadings(list: Pick<AccountListState, "rows" | "quiet">): DeviceReadings {
  const threads = new Map<string, Set<string>>()
  for (const row of list.rows) {
    if (row.runsOn.kind !== "device") continue
    const there = threads.get(row.runsOn.deviceId) ?? new Set<string>()
    there.add(row.thread)
    threads.set(row.runsOn.deviceId, there)
  }
  return {
    runs: new Map([...threads].map(([device, there]) => [device, { threads: there.size, fins: 0 }])),
    heard: new Set([...threads.keys()].filter((device) => !list.quiet.has(device))),
  }
}

import type { AccountListState } from "./account-list"

export type ConnectStep = "install" | "sign-in" | "connect"

/** Where an account stands with its Macs: none yet, one that joined but hasn't been heard from, or one that's there. */
export interface MacConnection {
  /** The newest Mac that joined, if any. */
  mac?: { id: string; name: string }
  /** It's there: it listed what it runs, or answered. */
  connected: boolean
  /**
   * A Mac of the account has connected at some time: there now, or quiet, which only a Mac whose link was up once can
   * be. One asleep with nothing to list is a Mac to wake, not one to connect.
   */
  heard: boolean
}

/**
 * Whether the account has a Mac, and whether it's there: the newest desktop device, there once it lists anything and
 * isn't quiet, or answered a call from here. A Mac that has never been heard from is neither off nor on. (A device's
 * `lastSeenAt` can't say so: the account writes it as the device joins, before it ever connects.)
 */
export function macConnection(list: Pick<AccountListState, "devices" | "rows" | "quiet">, answeredMacs: ReadonlySet<string>): MacConnection {
  const macs = [...list.devices.values()].filter((device) => device.kind === "desktop")
  const listing = new Set(list.rows.flatMap((row) => (row.runsOn.kind === "device" ? [row.runsOn.deviceId] : [])))
  const there = macs.find((mac) => !list.quiet.has(mac.id) && (listing.has(mac.id) || answeredMacs.has(mac.id)))
  const mac = there ?? macs.sort((left, right) => (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? ""))[0]
  const heard = there !== undefined || macs.some((each) => list.quiet.has(each.id))
  return { ...(mac && { mac: { id: mac.id, name: mac.name } }), connected: there !== undefined, heard }
}

/** The step a checklist is on: the first not done. A Mac heard from before has nothing left to connect. */
export function connectStep(connection: MacConnection): ConnectStep | "done" {
  if (!connection.mac) return "install"
  return connection.heard ? "done" : "connect"
}


import type { DeviceRuns } from "@mako/host/contracts/account-devices"

/*
 * What a Mac's window knows of the account's devices from the conversations it holds: its own, and the ones its host
 * listed from the account on another device, each carrying the account's word on that device (quiet since a time, or
 * nothing while it's heard). Pure, so Settings › Devices and its test read it the same way.
 */

/** A conversation as this reads it: where it runs, whether it's a Fin, and its device's quiet word. */
export interface PlacedConversation {
  kind: string
  key: string
  /** Where it runs when not on this Mac, by its device's name. */
  elsewhere?: string | undefined
  quietSince?: number | undefined
  /** Set on a Fin. */
  parent?: unknown
  threadId?: string | undefined
}

/**
 * A few numbers a place, each under a letter before its name (`t` Threads, `f` Fins, `q` quiet since, `h` heard): a
 * flat record a store's selector compares by its numbers, so a token streaming somewhere wakes nothing. This Mac's
 * own are under the empty name. Sessions fold into their Threads; a Fin counts as a Fin, not a Thread.
 */
export function placeCounts(conversations: Iterable<PlacedConversation>) {
  const threads = new Map<string, Set<string>>()
  const counted: Record<string, number> = {}
  for (const conversation of conversations) {
    if (conversation.kind !== "live") continue
    const place = conversation.elsewhere ?? ""
    if (conversation.elsewhere !== undefined) {
      if (conversation.quietSince === undefined) counted[`h${place}`] = 1
      else counted[`q${place}`] = Math.max(counted[`q${place}`] ?? 0, conversation.quietSince)
    }
    if (conversation.parent) {
      counted[`f${place}`] = (counted[`f${place}`] ?? 0) + 1
      continue
    }
    const there = threads.get(place) ?? new Set<string>()
    there.add(conversation.threadId ?? conversation.key)
    threads.set(place, there)
  }
  for (const [place, there] of threads) counted[`t${place}`] = there.size
  return counted
}

/** What Settings › Devices is handed of each device: what runs there, and the account's word on it. */
export interface DeviceEvidence {
  runs: Map<string, DeviceRuns>
  quiet: Map<string, string>
  heard: Set<string>
}

/**
 * The counts by device. What runs there is said whatever the link; the account's word on a device (quiet since, or
 * there because it lists work that isn't quiet) is said only while this Mac's own link to the account is up
 * (`connected`): its host hears each device going quiet or coming back on that link, so with the link down the
 * conversations it listed are from before and say nothing of now, and each device's own record says how it stands.
 */
export function deviceEvidence(counts: Readonly<Record<string, number>>, devices: ReadonlyArray<{ id: string; name: string }>, current: string, connected: boolean): DeviceEvidence {
  const evidence: DeviceEvidence = { runs: new Map(), quiet: new Map(), heard: new Set() }
  for (const device of devices) {
    const place = device.id === current ? "" : device.name
    const threads = counts[`t${place}`] ?? 0
    const fins = counts[`f${place}`] ?? 0
    if (threads || fins) evidence.runs.set(device.id, { threads, fins })
    if (!connected || device.id === current) continue
    const quietSince = counts[`q${place}`]
    if (counts[`h${place}`]) evidence.heard.add(device.id)
    else if (quietSince !== undefined) evidence.quiet.set(device.id, new Date(quietSince).toISOString())
  }
  return evidence
}

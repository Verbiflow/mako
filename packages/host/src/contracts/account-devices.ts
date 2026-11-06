import type { CloudDevice } from "./cloud-account.js"

/**
 * The account's devices as a list of them reads each: what a Mac's Settings and a browser's both show, by one set of
 * rules, so a device never reads as a Mac on one and a machine on the other. Nothing here asks the cloud: every
 * function reads what a list already holds.
 */

/** One of the account's devices as `GET /v1/devices` answers it. A kind a newer cloud adds is read as it came. */
export type DeviceRecord = Pick<CloudDevice, "id" | "name" | "platform"> & { kind: string } & Partial<Pick<CloudDevice, "appVersion" | "enrolledBy" | "createdAt" | "lastSeenAt" | "enrolledFrom">>

/**
 * What a device is to its person: a Mac running the app, a machine of their own running Mako's host with no window
 * (the `runtime` kind), a terminal, a browser, or a kind this build doesn't know.
 */
export type DeviceFamily = "mac" | "machine" | "terminal" | "browser" | "other"

export function deviceFamily(kind: string): DeviceFamily {
  if (kind === "desktop") return "mac"
  if (kind === "runtime") return "machine"
  if (kind === "cli") return "terminal"
  return kind === "browser" ? "browser" : "other"
}

/** A device's kind in words: "Mac", "Linux machine", "Terminal". A machine says its system when its platform does. */
export function deviceKindWords(device: Pick<DeviceRecord, "kind" | "platform">): string {
  const family = deviceFamily(device.kind)
  if (family === "mac") return "Mac"
  if (family === "terminal") return "Terminal"
  if (family === "browser") return "Browser"
  if (family === "other") return "Device"
  if (/^linux/i.test(device.platform)) return "Linux machine"
  return /^(macos|darwin)/i.test(device.platform) ? "Mac with no window" : "Machine"
}

/**
 * Where a Thread or a Fin runs when it isn't here, as its mark draws it: a cloud machine, a machine of the person's
 * own, or another of their computers.
 */
export type RunPlace = "cloud" | "machine" | "device"

/** The place a Session's row names: the cloud, else by its device's kind (one the list doesn't know reads as a computer). */
export function runPlace(cloud: boolean, deviceKind: string | undefined): RunPlace {
  if (cloud) return "cloud"
  return deviceKind !== undefined && deviceFamily(deviceKind) === "machine" ? "machine" : "device"
}

/**
 * How a device stands with the account: there now, quiet since a time, or enrolled and never heard from. `quiet`
 * carries when the cloud last heard from it.
 */
export type DeviceHealth = { state: "online" } | { state: "quiet"; since: number } | { state: "never" }

/** A device renews its connection every few minutes while it's on, which moves `lastSeenAt`: within this, it's there. */
const SEEN_NOW_MS = 10 * 60_000
/** The cloud writes `lastSeenAt` as a device joins: one that never moved past that never connected. */
const JOIN_WRITE_MS = 60_000

/**
 * A device's health from what a list holds of it. `quietSince` is the account's own word (its `device-quiet`), where
 * the list hears it; `heard` says it listed Sessions or answered a call. Without either, `lastSeenAt` decides: moved
 * in the last few minutes it's there, never moved since it joined it never connected, else it's quiet since then.
 */
export function deviceHealth(device: Pick<DeviceRecord, "createdAt" | "lastSeenAt">, facts: { current: boolean; quietSince?: string | undefined; heard?: boolean; now: number }): DeviceHealth {
  if (facts.current) return { state: "online" }
  const quiet = facts.quietSince === undefined ? Number.NaN : Date.parse(facts.quietSince)
  if (Number.isFinite(quiet)) return { state: "quiet", since: Math.min(quiet, facts.now) }
  if (facts.heard) return { state: "online" }
  const seen = device.lastSeenAt === undefined ? Number.NaN : Date.parse(device.lastSeenAt)
  if (!Number.isFinite(seen)) return { state: "never" }
  if (facts.now - seen < SEEN_NOW_MS) return { state: "online" }
  const joined = device.createdAt === undefined ? Number.NaN : Date.parse(device.createdAt)
  if (Number.isFinite(joined) && seen - joined < JOIN_WRITE_MS) return { state: "never" }
  return { state: "quiet", since: Math.min(seen, facts.now) }
}

/** "Online now", "Quiet since 14:02" (the day too once it isn't today's), "Never connected". */
export function healthWords(health: DeviceHealth, now: number): string {
  if (health.state === "online") return "Online now"
  if (health.state === "never") return "Never connected"
  const since = new Date(health.since)
  const today = new Date(now)
  const sameDay = since.getFullYear() === today.getFullYear() && since.getMonth() === today.getMonth() && since.getDate() === today.getDate()
  const time = since.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  if (sameDay) return `Quiet since ${time}`
  const day = since.toLocaleDateString(undefined, { month: "short", day: "numeric", year: since.getFullYear() === today.getFullYear() ? undefined : "numeric" })
  return `Quiet since ${day}, ${time}`
}

/**
 * The oldest Mako a device may run for this build to work with it. Releases up to 0.1.37 shipped before devices could
 * reach each other through the account, so one of them is listed and can't be watched, steered or started on. Raise it
 * when a build starts asking devices for something an older host refuses.
 */
export const DEVICE_MAKO_NEEDED = "0.1.38"

/** A checkout's build says 0.0.1 (`+development` where a build stamps it): no release to compare, so never behind. */
const DEVELOPMENT_VERSION = /^0\.0\.1(?:\+|$)|\+development$/

/**
 * Whether a device's Mako is behind what this build needs (`DEVICE_MAKO_NEEDED`). A device that never said its
 * version, a development build, and a version that doesn't read as numbers are never called behind: only a known
 * older release is.
 */
export function needsMakoUpdate(appVersion: string | null | undefined, needed: string = DEVICE_MAKO_NEEDED): boolean {
  if (!appVersion || DEVELOPMENT_VERSION.test(appVersion)) return false
  const parts = (version: string) => version.split(/[-+]/, 1)[0]!.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN))
  const has = parts(appVersion)
  const wants = parts(needed)
  if (has.some(Number.isNaN) || wants.some(Number.isNaN)) return false
  for (let index = 0; index < Math.max(has.length, wants.length); index++) {
    const difference = (has[index] ?? 0) - (wants[index] ?? 0)
    if (difference !== 0) return difference < 0
  }
  return false
}

/** What runs on a device, as far as a list knows: its Sessions, and the Fins placed there (none where the list can't say). */
export interface DeviceRuns {
  sessions: number
  fins: number
}

/** A device that joined the account, as its stream says it (`device-joined`), and when this window heard. */
export interface JoinedDevice {
  id: string
  kind: string
  name: string
  platform: string
  enrolledBy: "browser" | "device-code"
  from: { city: string | null; region: string | null; country: string | null } | null
  /** When this window heard of it, in ms since the epoch. */
  at: number
}

/*
 * Adding a machine: what a person runs there, in one place, so Settings, the web and the guide say the same lines.
 * `docs/linux-device.md` is the guide; a line here changes with it.
 */

/** The guide to running Mako on a machine of one's own: building its host or its image, the service, the sign-in's key. */
export const MACHINE_GUIDE_URL = "https://github.com/Verbiflow/mako/blob/main/docs/linux-device.md"

/** The cloud's address as a command takes it, from the host a window shows (`cloud.example.com`, `127.0.0.1:8787`). */
export function cloudAddress(cloud: string): string {
  if (/^https?:\/\//.test(cloud)) return cloud.replace(/\/+$/, "")
  const host = cloud.replace(/:\d+$/, "")
  const loopback = host === "localhost" || host === "[::1]" || host.startsWith("127.") || host.endsWith(".localhost")
  return `${loopback ? "http" : "https"}://${cloud}`
}

/**
 * The line that joins a machine to the account, run where Mako's host is installed: it prints a page and a code to
 * confirm. `cloud` is the account's cloud; left out, the host joins the cloud its build names.
 */
export function joinCommand(cloud: string | undefined): string {
  return cloud ? `mako-host join --cloud ${cloudAddress(cloud)}` : "mako-host join"
}

/** The line after it: the host, running as the device it joined as. */
export const HOST_COMMAND = "mako-host"

/** The image's name as the guide builds it, and the container's. */
export const MACHINE_IMAGE = "mako-device"

/**
 * The same in a container of the host's image, its data on a volume so a new container is the same device: it joins on
 * its first start, then runs. `MAKO_CLOUD_URL` is left for the person to fill where the window doesn't know the cloud.
 */
export function containerCommand(cloud: string | undefined): string {
  return `docker run -d --init --name ${MACHINE_IMAGE} -v ${MACHINE_IMAGE}:/data \\\n  -e MAKO_CLOUD_URL=${cloud ? cloudAddress(cloud) : "<your Mako cloud>"} ${MACHINE_IMAGE}`
}

/** Where a container says the page and the code to confirm. */
export const CONTAINER_LOGS_COMMAND = `docker logs -f ${MACHINE_IMAGE}`

/** The page where a signed-in person types a machine's code, when they didn't open the link it printed. */
export function codePage(cloud: string): string {
  return `${cloudAddress(cloud)}/device`
}

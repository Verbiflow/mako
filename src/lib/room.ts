import { FIT_RUNS, type RoomApp, type RoomFit, type RoomView } from "@mako/host/contracts/thread-app"
import { formatAgo, formatBytes } from "@/state/thread-app"
import { threadTitle } from "@/state/thread-titles"

/**
 * The Room's words: what each app on this Mac is, what it holds, and how
 * many copies of a project's app fit. React-free, so the rail and its
 * checks read the same sentences.
 */

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

function upFor(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "under a minute"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`
}

/** A crashed app is said on its own Thread, with Restart, for this long after it was last used; then it's dropped. */
export const CRASHED_KEPT_MS = 24 * 60 * 60_000

/** The apps worth listing: every one but a crash older than a day, which nobody is waiting on. */
export function roomApps(apps: readonly RoomApp[], now: number): RoomApp[] {
  return apps.filter((app) => app.state !== "crashed" || (app.usedAt ?? app.upAt ?? now) > now - CRASHED_KEPT_MS)
}

/** A Thread's title the host knows, or the one this window does when the host's is its placeholder. */
function threadName(thread: NonNullable<RoomApp["thread"]>): string | undefined {
  const title = thread.title.trim()
  if (title && title !== "Untitled Thread") return title
  return threadTitle(thread.id)
}

/** Its Thread's title, the folder it runs in, or what a spare checkout is for. */
export function roomTitle(app: RoomApp): string {
  const named = app.thread ? threadName(app.thread) : undefined
  if (named) return named
  if (app.kind === "spare") return "Checkout for a new Thread"
  if (app.thread && app.checkout) return `${app.project?.name ?? basename(app.checkout)} · ${basename(app.checkout)}`
  return app.checkout ? basename(app.checkout) : "An app"
}

/** The row's second line: its project, what runs, how long it has been up, and when someone last used it. */
export function roomDetail(app: RoomApp, now: number): string {
  const parts: string[] = []
  if (app.project && app.project.name !== roomTitle(app)) parts.push(app.project.name)
  if (app.state === "waiting") {
    parts.push(app.waitingSince === undefined ? "waiting for memory" : `waiting for memory for ${upFor(now - app.waitingSince)}`)
    return parts.join(" · ")
  }
  if (app.kind === "spare") parts.push(app.thread ? "installing, from before this Thread took the checkout" : "installing ahead")
  else if (app.runs.length) parts.push(app.runs.join(", "))
  if (app.state === "crashed") parts.push("crashed")
  else if (app.upAt !== undefined) parts.push(`up ${upFor(now - app.upAt)}`)
  if (app.usedAt && app.kind !== "spare") parts.push(`used ${formatAgo(app.usedAt, now)}`)
  return parts.join(" · ")
}

export function roomMemory(app: RoomApp): string | undefined {
  if (app.memoryBytes === undefined) return app.containers ? "containers" : undefined
  return app.containers ? `${formatBytes(app.memoryBytes)}+` : formatBytes(app.memoryBytes)
}

/** The row's tip: everything on it, in sentences. */
export function roomTip(app: RoomApp, now: number): string {
  return [
    roomTitle(app),
    app.checkout,
    roomDetail(app, now),
    app.port === undefined ? undefined : `Port ${app.port}`,
    app.memoryBytes === undefined ? undefined : app.containerBytes ? `Holds ${formatBytes(app.memoryBytes)} of memory, ${formatBytes(app.containerBytes)} of it in its containers.` : `Holds ${formatBytes(app.memoryBytes)} of memory.`,
    app.containers ? "It starts containers Mako couldn't read: none was started by Compose in its checkout or mounts a folder of it, or no container runtime answered. Their memory isn't counted here." : undefined,
  ].filter(Boolean).join("\n")
}

export interface FitLine {
  text: string
  tip: string
}

/** A project's line under the apps, short, with the whole sentence for its tip. */
export function fitLine(fit: RoomFit): FitLine {
  const { estimate, name } = fit
  if (estimate.kind === "learning")
    return {
      text: `${name}: learning its size, ${estimate.runs} of ${FIT_RUNS} runs`,
      tip: `Mako says how many copies of ${name}'s app fit once ${FIT_RUNS} of its runs have stayed up a minute. ${estimate.runs} ${estimate.runs === 1 ? "has" : "have"} so far.`,
    }
  if (estimate.kind === "containers")
    return {
      text: `${name}: uses containers`,
      tip: `${name}'s app starts containers Mako couldn't read, so it can't say how many copies fit. Mako reads the containers Compose starts in the app's checkout, and those that mount a folder of it.`,
    }
  const contained = estimate.containerBytes ? `, ${formatBytes(estimate.containerBytes)} of it in its containers` : ""
  const each = `Each copy of ${name}'s app peaks around ${formatBytes(estimate.peakBytes)}${contained}, the median of its last ${estimate.runs} runs.`
  if (estimate.atOnce === undefined) return { text: `${name}: about ${formatBytes(estimate.peakBytes)} each`, tip: each }
  const room = estimate.limitedBy === "containers"
    ? `The container runtime's machine has room for the containers of about ${estimate.atOnce}, fewer than free memory would hold, counting the ${estimate.running} running.`
    : `With the memory free now, about ${estimate.atOnce} fit at once, counting the ${estimate.running} running.`
  return { text: `${name}: about ${estimate.atOnce} at once`, tip: `${each} ${room}` }
}

export function memoryLine(room: RoomView): string {
  const pressure = `Memory pressure ${room.pressure}`
  if (room.freeBytes === undefined) return pressure
  return `${pressure} · ${formatBytes(room.freeBytes)} free${room.totalBytes === undefined ? "" : ` of ${formatBytes(room.totalBytes)}`}`
}

/** The apps stopping these would take from someone: another Thread's or folder's, not the one in view nor a spare checkout's install. */
export function othersAmong(apps: readonly RoomApp[], focused: string | null | undefined): RoomApp[] {
  return apps.filter((app) => app.kind !== "spare" && (!focused || app.checkout !== focused))
}

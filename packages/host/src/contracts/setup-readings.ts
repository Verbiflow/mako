import type { CarriedFilesView } from "./cloud-carried-files.js"
import type { CloudSignInsState } from "./cloud-sign-ins.js"
import type { RecipeView } from "./project-app.js"
import { bytes, type PlaceReading, type SetupPlace, type SyncState } from "./setup.js"

/**
 * A place's own readings as Setup rows, from what a device already knows: the recipe's carry, prepare and processes,
 * the project's carried files in the cloud, sign-ins and saved keys by name. Pure, so the host and its tests read the
 * same rows; the broker's grants and leases take a row's place once they cover the same thing.
 */

type ReadingRow = PlaceReading["rows"][number]

function portWords(port: string | undefined): string {
  if (!port) return "no port"
  const own = /^\{\s*port\s*(?:\+\s*(\d+))?\s*\}$/.exec(port)
  if (own) return own[1] ? `the Thread's port + ${own[1]}` : "the Thread's first port"
  return /^\d+$/.test(port) ? `port ${port} for every Thread` : port
}

function list(entries: readonly string[]): string {
  if (entries.length <= 1) return entries.join("")
  return `${entries.slice(0, -1).join(", ")} and ${entries.at(-1)}`
}

/** The project's own repository: every place clones it and pushes its own branch. */
export function repositoryRow(repository: string | null, place: SetupPlace, at: number): ReadingRow[] {
  if (!repository) return []
  const detail =
    place.kind === "cloud"
      ? "Clones main, pushes its own branch, opens pull requests as Mako"
      : place.here
        ? "The main checkout here; each Thread works on its own branch in a worktree"
        : "Its own clone; worktrees for each Thread"
  return [{ reading: "repository", part: "code", icon: "repository", name: repository, mono: true, detail, sync: { state: "synced", at } }]
}

/**
 * The recipe's carry on the device it's read on: copies each new worktree gets, links every worktree shares. A
 * missing copy is said so (the main checkout lacks it), and a credentials file says agents are told not to open it.
 */
export function carryRows(recipe: RecipeView, present: ReadonlyMap<string, { at: number; size?: number }>): ReadingRow[] {
  return recipe.carry.map((entry): ReadingRow => {
    const found = present.get(entry.path)
    const parts = [entry.link ? "Linked to the main checkout, so every worktree shares it" : "Copied into each new worktree from the main checkout"]
    if (found?.size !== undefined && !entry.link) parts.push(bytes(found.size))
    if (entry.credentials) parts.push("agents are told never to open it")
    const sync: SyncState = !found ? { state: "missing" } : entry.link ? { state: "here" } : { state: "synced", at: found.at }
    return {
      reading: "recipe-carry",
      part: "files",
      icon: entry.path.endsWith("/") || entry.link ? "folder" : "file",
      name: entry.path,
      mono: true,
      detail: found ? parts.join(" · ") : "The recipe carries it, but the main checkout has none",
      sync,
      target: entry.path,
    }
  })
}

/** The target of the one row whose Add copies every carried file of the project: the person's word is for all of them. */
export const CARRIED_ALL = "carried:all"

/**
 * The project's carried files in the cloud, as this Mac's store and the account's say they stand. Copying them is one
 * word for the whole project (`CloudCarriedFiles.decide`), so until it's given, one row names every file it covers
 * and offers it; no file's own row does, so a tap on one file never sends the others.
 */
export function carriedCloudRows(view: CarriedFilesView, from: string): ReadingRow[] {
  const allowed = view.decision === "allowed"
  const rows: ReadingRow[] = []
  if (!allowed && view.files.length)
    rows.push({
      reading: "carried-cloud",
      part: "files",
      icon: "folder",
      name: view.decision === "declined" ? "Kept on this Mac" : "Not copied yet",
      mono: false,
      detail: `Add copies ${list(view.files.map((file) => file.path))} from ${from}, encrypted, to every cloud Thread of this project; agents see names only`,
      sync: { state: "missing" },
      target: CARRIED_ALL,
    })
  for (const file of view.files) {
    const sync: SyncState =
      !allowed || file.kept ? { state: "here" }
      : !file.cloud ? { state: "missing" }
      : !file.cloud.current ? { state: "newer", source: "Mac's" }
      : { state: "synced", at: Date.parse(file.cloud.savedAt) }
    const parts = [file.kept ? `Kept on ${from}; you took it out of the cloud` : allowed ? `From ${from}` : `On ${from}; it goes with the project's other files or not at all`, bytes(file.bytes)]
    if (file.credentials) parts.push("encrypted", "agents see names only")
    rows.push({ reading: "carried-cloud", part: "files", icon: "file", name: file.path, mono: true, detail: parts.join(" · "), sync, target: file.path })
  }
  for (const staying of view.staying)
    rows.push({ reading: "carried-cloud", part: "files", icon: "folder", name: staying.path, mono: true, detail: `Stays on ${from}: ${staying.why}`, sync: { state: "here" }, target: staying.path })
  return rows
}

/** The recipe's prepare: what each Thread runs before it starts, here or baked into the cloud's base. */
export function prepareRows(recipe: RecipeView, place: SetupPlace, at: number): ReadingRow[] {
  return recipe.prepare.map((step): ReadingRow => {
    const again = step.inputs.length ? `reruns after ${list(step.inputs)} changes` : "runs once in each checkout"
    const detail =
      place.kind === "cloud" ? `The recipe's prepare, baked into the base · ${again}`
      : step.link ? `The recipe's prepare · ${list(step.outputs.map((output) => output.replace(/^\*\*\//, "")))} linked to the main checkout while ${list(step.inputs)} match`
      : `The recipe's prepare · ${again}`
    return { reading: "recipe-prepare", part: "tools", icon: "tool", name: step.command, mono: true, detail, sync: { state: "synced", at } }
  })
}

/** What the recipe starts in each Thread, on its own port. `up` is the port each one is up on, for one Thread's place. */
export function processRows(recipe: RecipeView, place: SetupPlace, at: number, up?: ReadonlyMap<string, number>): ReadingRow[] {
  return recipe.processes.map((process): ReadingRow => {
    const running = up?.get(process.name)
    const sync: SyncState = running !== undefined ? { state: "up", port: running } : place.kind === "device" && place.here ? { state: "here" } : { state: "synced", at }
    return { reading: "recipe-process", part: "services", icon: "service", name: process.name, mono: true, detail: `${process.command} · ${portWords(process.port)}`, sync }
  })
}

/** This device's harness sign-ins, by harness name, kept here. */
export function signInRows(names: readonly string[]): ReadingRow[] {
  if (!names.length) return []
  return [{ reading: "sign-in", part: "access", icon: "key", name: list(names), mono: false, detail: "Signed in on this device", scope: "account", sync: { state: "here" } }]
}

/** Keys saved in Settings › Models, by the name the person gave each. */
export function savedKeyRows(names: readonly string[]): ReadingRow[] {
  return names.map((name): ReadingRow => ({ reading: "saved-key", part: "access", icon: "key", name, mono: false, detail: "Saved in Settings › Models", scope: "account", sync: { state: "here" } }))
}

/** The person's sign-ins as the cloud's machines get them: shared and fresh, or not shared yet. */
export function cloudSignInRows(state: CloudSignInsState | undefined, labels: (harness: string) => string): ReadingRow[] {
  if (!state) return []
  if (!state.sharing || state.blocked)
    return [{ reading: "sign-in", part: "access", icon: "key", name: "Your sign-ins", mono: false, detail: "Add shares every harness sign-in on this Mac with all your cloud Threads, in every project; agents never see them", scope: "account", sync: { state: "missing" }, target: "share-sign-ins" }]
  const sent = state.harnesses.filter((row) => row.status === "sent")
  const failed = state.harnesses.filter((row) => row.status === "failed")
  const rows: ReadingRow[] = []
  if (sent.length) {
    const latest = Math.max(...sent.map((row) => Date.parse(row.sentAt ?? state.checkedAt ?? "") || 0))
    rows.push({
      reading: "sign-in",
      part: "access",
      icon: "key",
      name: list(sent.map((row) => labels(row.harness))),
      mono: false,
      detail: "Your sign-ins, kept fresh by Mako for every project",
      scope: "account",
      sync: { state: "synced", at: latest },
    })
  }
  for (const row of failed)
    rows.push({ reading: "sign-in", part: "access", icon: "key", name: labels(row.harness), mono: false, detail: "Your sign-in", scope: "account", sync: { state: "failed", why: row.problem ?? "it didn't send" }, target: "share-sign-ins" })
  return rows
}

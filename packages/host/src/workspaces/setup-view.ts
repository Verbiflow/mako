import { stat } from "node:fs/promises"
import { join } from "node:path"
import type { MethodTable } from "../base/methods.js"
import { onLinux, onMac, onWindows } from "../base/platform.js"
import type { AccountCatalog } from "../contracts/accounts.js"
import type { CarriedFilesView } from "../contracts/cloud-carried-files.js"
import type { CloudSignInsState } from "../contracts/cloud-sign-ins.js"
import type { ModelConnectionsSnapshot } from "../contracts/model-connections.js"
import type { ProjectAppSetup } from "../contracts/project-app.js"
import { setupView, SetupActSchema, type PlaceReading, type Platform, type SetupAct, type SetupActOutcome, type SetupPlace, type SetupView } from "../contracts/setup.js"
import { carriedCloudRows, carryRows, cloudSignInRows, prepareRows, processRows, repositoryRow, savedKeyRows, signInRows } from "../contracts/setup-readings.js"

/**
 * A project's Setup as this device reads it: this device's own place from the recipe (its carry, prepare and
 * processes), its sign-ins and saved keys by name; and the cloud's place from the project's carried files and the
 * shared sign-ins, while the account has the cloud. The broker's grants, leases and asks join these once the device's
 * broker serves them; until then a page shows what each place reads of itself. Nothing read here is a value.
 */
export interface SetupViewDeps {
  recipe(folder: string): Promise<ProjectAppSetup | undefined>
  carried?: {
    view(folder: string): Promise<CarriedFilesView>
    decide(folder: string, allowed: boolean): Promise<CarriedFilesView>
    keep(folder: string, path: string, keep: boolean): Promise<CarriedFilesView>
  }
  cloudSignIns?: { state(): Promise<CloudSignInsState | undefined>; share(sharing: boolean): Promise<void> }
  accounts(): Promise<AccountCatalog>
  keys(): Promise<ModelConnectionsSnapshot>
  device(): Promise<{ id: string | undefined; name: string }>
  label(harness: string): string
  now?(): number
}

const platform = (): Platform => (onMac() ? "mac" : onLinux() ? "linux" : onWindows() ? "windows" : "other")
const HOME = /^\/(?:Users|home)\/[^/]+(?=\/|$)/

async function present(root: string, paths: readonly string[]): Promise<Map<string, { at: number; size?: number }>> {
  const found = new Map<string, { at: number; size?: number }>()
  await Promise.all(
    paths.map(async (path) => {
      const info = await stat(join(root, path)).catch(() => undefined)
      if (info) found.set(path, { at: info.mtimeMs, ...(info.isFile() && { size: info.size }) })
    })
  )
  return found
}

export class SetupViews {
  readonly #deps: SetupViewDeps

  constructor(deps: SetupViewDeps) {
    this.#deps = deps
  }

  async view(folder: string): Promise<SetupView> {
    const deps = this.#deps
    const now = deps.now?.() ?? Date.now()
    const [setup, carried, signIns, accounts, keys, device] = await Promise.all([
      deps.recipe(folder).catch(() => undefined),
      deps.carried?.view(folder).catch(() => undefined),
      deps.cloudSignIns?.state().catch(() => undefined),
      deps.accounts().catch(() => undefined),
      deps.keys().catch(() => undefined),
      deps.device(),
    ])
    const root = setup?.root ?? folder
    const recipe = setup?.recipe.kind === "ready" ? setup.recipe.recipe : undefined
    const recipeAt = setup?.recipe.kind === "ready" ? (setup.recipe.savedAt ?? now) : now
    const repository = carried?.repository ? carried.repository.replace(/^https:\/\/github\.com\//, "") : null
    const here: SetupPlace = { kind: "device", device: device.id ?? "this", name: device.name, platform: platform(), here: true, online: true }
    const signedIn = [...new Set((accounts?.accounts ?? []).filter((account) => account.active && !account.signedOut && !account.missing).map((account) => deps.label(account.harness)))]
    const saved = (keys?.connections ?? []).filter((connection) => connection.credential).map((connection) => connection.name)
    const mac: PlaceReading = {
      place: here,
      checkout: root.replace(HOME, "~"),
      rows: [
        ...repositoryRow(repository, here, now),
        ...(recipe ? carryRows(recipe, await present(root, recipe.carry.map((entry) => entry.path))) : []),
        ...signInRows(signedIn),
        ...savedKeyRows(saved),
        ...(recipe ? prepareRows(recipe, here, recipeAt) : []),
        ...(recipe ? processRows(recipe, here, recipeAt) : []),
      ],
    }
    const places = [mac]
    if (carried?.repository) {
      const cloud: SetupPlace = { kind: "cloud" }
      places.push({
        place: cloud,
        rows: [
          ...repositoryRow(repository, cloud, now),
          ...carriedCloudRows(carried, device.name),
          ...cloudSignInRows(signIns, deps.label),
          ...(recipe ? prepareRows(recipe, cloud, recipeAt) : []),
          ...(recipe ? processRows(recipe, cloud, recipeAt) : []),
        ],
      })
    }
    return setupView({ now, project: { name: setup?.project ?? root.split("/").filter(Boolean).at(-1) ?? root, root, repository }, places })
  }

  /** One tap on the page, done where this device can do it, and said why not where it can't yet. */
  async act(folder: string, act: SetupAct): Promise<SetupActOutcome> {
    const deps = this.#deps
    if (act.act === "rebuild") return { done: false, why: "The cloud rebuilds a project's base itself when its recipe or main changes." }
    if (act.act === "answer") return { done: false, why: "Asks are answered by the account's broker, which this Mac doesn't run yet." }
    const view = await this.view(folder)
    const row = view.places.find((place) => place.id === act.place)?.parts.flatMap((part) => part.rows).find((entry) => entry.id === act.row)
    if (!row) return { done: false, why: "That row isn't on the page anymore." }
    if (row.origin.from === "reading" && row.origin.reading === "carried-cloud" && row.target && deps.carried) {
      const carried = await deps.carried.view(folder)
      if (carried.decision !== "allowed") await deps.carried.decide(folder, true)
      else await deps.carried.keep(folder, row.target, false)
      return { done: true }
    }
    if (row.target === "share-sign-ins" && deps.cloudSignIns) {
      await deps.cloudSignIns.share(true)
      return { done: true }
    }
    if (row.origin.from === "reading" && row.origin.reading === "recipe-carry")
      return { done: false, why: `Put ${row.name} in the main checkout; each new worktree copies it from there.` }
    return { done: false, why: "That needs the account's broker, which this Mac doesn't run yet." }
  }
}

/** The page's two calls: read a project's Setup, and act on it. */
export function declareSetupMethods(methods: MethodTable, views: SetupViews) {
  methods.handle("mako:setup", (folder: string): Promise<SetupView> => views.view(folder))
  methods.handle("mako:setup-act", (folder: string, act: SetupAct): Promise<SetupActOutcome> => views.act(folder, SetupActSchema.parse(act)))
}

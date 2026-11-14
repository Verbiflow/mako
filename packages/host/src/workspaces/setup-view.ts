import { stat } from "node:fs/promises"
import { join } from "node:path"
import type { MethodTable } from "../base/methods.js"
import { onLinux, onMac, onWindows } from "../base/platform.js"
import type { AccountCatalog } from "../contracts/accounts.js"
import type { CarriedFilesView } from "../contracts/cloud-carried-files.js"
import type { CloudSignInsState } from "../contracts/cloud-sign-ins.js"
import type { ModelConnectionsSnapshot } from "../contracts/model-connections.js"
import type { ProjectAppSetup } from "../contracts/project-app.js"
import type { Borrower, Grant, Lease, LeaseEvent, SourceAnswer, SourceAsk } from "@mako/protocol/borrow"
import type { LocalBorrowing } from "../base/local-borrowing.js"
import { SECRET_KINDS, type SecretKind } from "../base/secrets.js"
import { setupView, SetupActSchema, sourceAskOf, type AskAnswer, type Asker, type BorrowSnapshot, type BrokerReading, type PlaceReading, type Platform, type SetupAct, type SetupActOutcome, type SetupAsk, type SetupPlace, type SetupView } from "../contracts/setup.js"
import { CARRIED_ALL, carriedCloudRows, carryRows, cloudSignInRows, prepareRows, processRows, repositoryRow, savedKeyRows, signInRows } from "../contracts/setup-readings.js"
import { CHECKOUT_GRANTS, checkoutSource, LOCAL_DEVICE } from "./checkout-borrowing.js"

/** One of this device's own brokers, as Setup reads and answers it: the worktrees' checkouts, the saved secrets. */
export type LocalBroker = Pick<LocalBorrowing, "device" | "account" | "grants" | "leases" | "events" | "asks" | "answer" | "revoke">

/**
 * A project's Setup as this device reads it: this device's own place from the recipe (its carry, prepare and
 * processes), its sign-ins and saved keys by name, and its own brokers' grants and leases; the cloud's place from the
 * project's carried files and shared sign-ins, and the account broker's grants, leases and asks, while the account
 * has the cloud. Nothing read here is a value.
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
  borrowing?: {
    /** This device's own brokers; two over one folder are one broker, read once. */
    local(): Promise<LocalBroker[]>
    /** The account's broker; its snapshot is null from a cloud that has none yet, or for a Mac that isn't signed in. */
    account?: { snapshot(since: number): Promise<BorrowSnapshot | null>; answer(ask: string, answer: SourceAnswer): Promise<void>; revoke(grant: string): Promise<void> }
    /** The asking Thread as the person knows it. */
    asker?(thread: string): Asker | undefined
    /** A saved record's version now (`GrantedSecrets.version`), to say yes to a credential ask; never its value. */
    secretVersion?(kind: SecretKind, name: string): Promise<string | undefined>
  }
  now?(): number
}

/** How far back the lease log is read for refusals: a copy that didn't land a week ago still says so. */
const REFUSALS_SINCE_MS = 7 * 24 * 60 * 60_000

/** A saved record's grant (ref `<kind>/<name>`) as the person reads it. */
const SECRET_WORDS = {
  "saved-key": "Saved key",
  "harness-sign-in": "Sign-in",
  "credentials-file": "Credentials file",
  "browser-sign-in": "Browser sign-in",
  "mako-sign-in": "Mako sign-in",
} as const satisfies Record<SecretKind, string>

/** The device's two checkout grants, by the few words a row has room for. */
const CHECKOUT_WORDS = { [CHECKOUT_GRANTS.copy]: "Files Git ignores, copied", [CHECKOUT_GRANTS.live]: "Files Git ignores, linked" } as const satisfies Record<string, string>

function named(grant: Grant): Grant {
  if (grant.id === CHECKOUT_GRANTS.copy || grant.id === CHECKOUT_GRANTS.live) return { ...grant, label: CHECKOUT_WORDS[grant.id] }
  if (grant.resource.kind !== "credential") return grant
  const [kind, ...rest] = grant.resource.ref.split("/")
  const known = SECRET_KINDS.find((each) => each === kind)
  return known && rest.length ? { ...grant, label: `${SECRET_WORDS[known]}: ${rest.join("/")}` } : grant
}

async function snapshotOf(broker: LocalBroker, since: number): Promise<BorrowSnapshot> {
  const events: LeaseEvent[] = []
  for await (const event of broker.events(since)) events.push(event)
  const [grants, leases, asks] = await Promise.all([broker.grants(), broker.leases(), broker.asks()])
  return { grants, leases, events, asks }
}

/** The account broker names this Mac by its device ID; this device's own brokers, and the page, by `LOCAL_DEVICE`. */
function asHere<T>(value: T, device: string | undefined): T {
  if (!device) return value
  // SAFETY: the snapshot was parsed by the open contract; only device IDs, which are plain strings, are swapped.
  return JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(device), JSON.stringify(LOCAL_DEVICE))) as T
}

function placeOf(borrower: Borrower): string {
  return borrower.place.kind === "machine" ? "cloud" : `device:${borrower.place.device}`
}

type Held = { from: "local"; broker: LocalBroker } | { from: "account" }

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
  /** Where each ask on the page last came from, so its answer goes back there. */
  readonly #asks = new Map<string, { ask: SourceAsk; held: Held }>()

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
    const here: SetupPlace = { kind: "device", device: LOCAL_DEVICE, name: device.name, platform: platform(), here: true, online: true }
    const broker = await this.#broker(now, root, repository, device, here)
    const signedIn = [...new Set((accounts?.accounts ?? []).filter((account) => account.active && !account.signedOut && !account.missing).map((account) => deps.label(account.harness)))]
    const saved = (keys?.connections ?? []).filter((connection) => connection.credential).map((connection) => connection.name)
    const mac: PlaceReading = {
      place: here,
      checkout: root.replace(HOME, "~"),
      rows: [
        ...repositoryRow(repository, here, now),
        ...(recipe ? carryRows(recipe, await present(root, recipe.carry.map((entry) => entry.path))) : []),
        ...signInRows(signedIn),
        ...(broker.saved ? [] : savedKeyRows(saved)),
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
    return setupView({ now, project: { name: setup?.project ?? root.split("/").filter(Boolean).at(-1) ?? root, root, repository }, places, broker: broker.reading, threads: broker.threads })
  }

  /** Every broker's say, as one reading: this device's own and the account's, each ask kept with where it's answered. */
  async #broker(now: number, root: string, repository: string | null, device: { id: string | undefined; name: string }, here: Extract<SetupPlace, { kind: "device" }>) {
    const borrowing = this.#deps.borrowing
    const since = now - REFUSALS_SINCE_MS
    const local = (await borrowing?.local().catch((): LocalBroker[] => [])) ?? []
    const snapshots: Array<{ snapshot: BorrowSnapshot; held: Held }> = []
    for (const broker of local) {
      const snapshot = await snapshotOf(broker, since).catch(() => undefined)
      if (snapshot) snapshots.push({ snapshot, held: { from: "local", broker } })
    }
    const account = await borrowing?.account?.snapshot(since).catch(() => null)
    if (account) snapshots.push({ snapshot: asHere(account, device.id), held: { from: "account" } })
    const grants = new Map<string, Grant>()
    const leases = new Map<string, Lease>()
    const refusals = new Map<string, LeaseEvent>()
    const asks = new Map<string, SetupAsk>()
    this.#asks.clear()
    for (const { snapshot, held } of snapshots) {
      for (const grant of snapshot.grants) grants.set(grant.id, named(grant))
      for (const lease of snapshot.leases) leases.set(lease.id, lease)
      for (const event of snapshot.events) if (event.event === "refused") refusals.set(`${event.correlationId}\0${event.at}`, event)
      for (const waiting of snapshot.asks) {
        if (!waiting.ask.askPerson) continue
        const ours = waiting.ask.borrower.repository === repository || waiting.ask.borrower.repository === root
        if (!ours || asks.has(waiting.ask.ask)) continue
        const thread = waiting.ask.borrower.thread
        const by = borrowing?.asker?.(thread) ?? { thread, title: "A Thread", fin: false }
        asks.set(waiting.ask.ask, sourceAskOf(waiting, placeOf(waiting.ask.borrower), by))
        this.#asks.set(waiting.ask.ask, { ask: waiting.ask, held })
      }
    }
    const threads = new Set([...leases.values()].map((lease) => lease.borrower.thread))
    for (const ask of asks.values()) threads.add(ask.by.thread)
    const reading: BrokerReading | undefined = snapshots.length
      ? {
          account: snapshots[0]!.snapshot.grants[0]?.scope.account ?? "local",
          grants: [...grants.values()],
          leases: [...leases.values()],
          refusals: [...refusals.values()].sort((left, right) => left.at - right.at),
          asks: [...asks.values()],
          sourceVersions: {},
          devices: { [LOCAL_DEVICE]: { name: here.name, platform: here.platform, online: true, lastSeen: now } },
        }
      : undefined
    return { reading, threads: [...threads], saved: [...grants.values()].some((grant) => grant.resource.kind === "credential" && grant.resource.ref.startsWith("saved-key/")) }
  }

  /** One tap on the page, done where this device can do it, and said why not where it can't yet. */
  async act(folder: string, act: SetupAct): Promise<SetupActOutcome> {
    const deps = this.#deps
    if (act.act === "rebuild") return { done: false, why: "The cloud rebuilds a project's base itself when its recipe or main changes." }
    const view = await this.view(folder)
    if (act.act === "answer") return this.#answer(view.root, act.ask, act.answer)
    const row = view.places.find((place) => place.id === act.place)?.parts.flatMap((part) => part.rows).find((entry) => entry.id === act.row)
    if (!row) return { done: false, why: "That row isn't on the page anymore." }
    if (row.origin.from === "reading" && row.origin.reading === "carried-cloud" && row.target && deps.carried) {
      // The project's word covers every file its row names; one file's row only copies that file again, once given.
      if (row.target === CARRIED_ALL) {
        await deps.carried.decide(folder, true)
        return { done: true }
      }
      const carried = await deps.carried.view(folder)
      if (carried.decision !== "allowed") return { done: false, why: "This project's files go to the cloud together: Add on its own row first." }
      await deps.carried.keep(folder, row.target, false)
      return { done: true }
    }
    if (row.target === "share-sign-ins" && deps.cloudSignIns) {
      await deps.cloudSignIns.share(true)
      return { done: true }
    }
    if (row.origin.from === "reading" && row.origin.reading === "recipe-carry")
      return { done: false, why: `Put ${row.name} in the main checkout; each new worktree copies it from there.` }
    if (act.action === "stop" && row.origin.from !== "reading" && row.origin.from !== "ask") return this.#revoke(row.origin.grant)
    return { done: false, why: "That needs the account's broker, which this Mac doesn't reach yet." }
  }

  /** The person's yes or no to a source's ask: a yes says what this device has now, by its version, never its value. */
  async #answer(root: string, id: string, answer: AskAnswer): Promise<SetupActOutcome> {
    const held = this.#asks.get(id)
    if (!held) return { done: false, why: "That ask was answered already, or it's gone." }
    const { ask } = held
    let said: SourceAnswer
    if (answer === "decline") said = { answer: "no", by: { kind: "person", account: ask.borrower.account } }
    else if (ask.resource.kind === "file" || ask.resource.kind === "tree") said = await checkoutSource({ ...ask, borrower: { ...ask.borrower, repository: root } })
    else if (ask.resource.kind === "credential") said = await this.#credential(ask.ref)
    else return { done: false, why: "This Mac can't run or reach that for another place yet; only Decline answers it." }
    if (said.answer === "unavailable") return { done: false, why: ask.resource.kind === "credential" ? `Nothing is saved on this Mac as ${ask.ref}.` : `${ask.ref} isn't in the main checkout as it is now.` }
    if (held.held.from === "local") await held.held.broker.answer(id, said)
    else await this.#deps.borrowing?.account?.answer(id, said)
    return { done: true }
  }

  /** A credential ask's yes: the saved record's version as its leases name it, or why there's none. */
  async #credential(ref: string): Promise<SourceAnswer> {
    const [kind, ...rest] = ref.split("/")
    const known = SECRET_KINDS.find((each) => each === kind)
    const version = known && rest.length ? await this.#deps.borrowing?.secretVersion?.(known, rest.join("/")) : undefined
    return version ? { answer: "yes", version } : { answer: "unavailable", reason: "not-found" }
  }

  /** The person's Stop: the grant ends wherever it's kept, and every lease under it with it. */
  async #revoke(grant: string): Promise<SetupActOutcome> {
    const borrowing = this.#deps.borrowing
    for (const broker of (await borrowing?.local().catch((): LocalBroker[] => [])) ?? [])
      if ((await broker.grants()).some((held) => held.id === grant)) {
        await broker.revoke(grant, { kind: "person", account: broker.account })
        return { done: true }
      }
    if (!borrowing?.account) return { done: false, why: "That grant isn't this Mac's, and the account's broker can't be reached." }
    await borrowing.account.revoke(grant)
    return { done: true }
  }
}

/** The page's two calls: read a project's Setup, and act on it. */
export function declareSetupMethods(methods: MethodTable, views: SetupViews) {
  methods.handle("mako:setup", (folder: string): Promise<SetupView> => views.view(folder))
  methods.handle("mako:setup-act", (folder: string, act: SetupAct): Promise<SetupActOutcome> => views.act(folder, SetupActSchema.parse(act)))
}

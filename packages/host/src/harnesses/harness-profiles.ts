import { readFile, realpath } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { existsSync } from "node:fs"
import { commonDirOf } from "@mako/git"
import { workDefault } from "../contracts/harness-defaults.js"
import { carriedTuning, resolveHarnessTuning, withCatalogDefaults } from "./harness-models.js"
import type { NativeRunOptions } from "./native-runner.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { ProviderHost } from "./host.js"
import {
  pendingProviderProfile,
  unavailableProviderProfile,
  unknownProviderProfile,
  withWorkDefault,
  type ProfileLoadContext,
  type ProviderProfileLoader,
} from "./profile-loader.js"
import type { HarnessProfile } from "../contracts/providers-acp.js"
import { accountCatalog, type FolderDefaults, type ProviderProfileCache } from "./provider-profile-cache.js"
import type { Foreground } from "../base/foreground.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { drainOwnedWork, ownedWorkCompletion } from "../base/owned-work.js"

/** The checkout `folder` is in: the nearest folder above it, or itself, that Git keeps a `.git` in. */
function checkoutRoot(folder: string): string | undefined {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at
    if (dirname(at) === at) return undefined
  }
}

/**
 * Whether two folders are the same place in two checkouts of one repository, with the same bytes in every
 * project-level configuration file (`files`) from each checkout's root down to the folder. A file missing from both
 * is the same; a folder outside any repository is like no other.
 */
async function sameProjectConfiguration(left: string, right: string, files: readonly string[]): Promise<boolean> {
  try {
    const [leftRoot, rightRoot] = [checkoutRoot(left), checkoutRoot(right)]
    if (!leftRoot || !rightRoot || commonDirOf(left) !== commonDirOf(right)) return false
    const within = relative(leftRoot, left)
    if (within !== relative(rightRoot, right)) return false
    const levels = [""]
    for (const part of within.split(sep).filter(Boolean)) levels.push(join(levels.at(-1) ?? "", part))
    const bytes = (path: string) => readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined
      throw error
    })
    for (const level of levels) {
      for (const file of files) {
        const [ours, theirs] = await Promise.all([bytes(join(leftRoot, level, file)), bytes(join(rightRoot, level, file))])
        if (ours === undefined ? theirs !== undefined : theirs === undefined || !ours.equals(theirs)) return false
      }
    }
    return true
  } catch {
    // A configuration that can't be read is not known to be the same.
    return false
  }
}

export interface HarnessProfileEvent {
  profile: HarnessProfile
  cwd?: string
}

/**
 * How long an account's model list answers before a read refreshes it behind the answer. A list changes when the
 * harness's binary, its account or a connection does, and each of those asks again by itself; opening the picker
 * asks too. At 30 s every read was a discovery: six CLIs at each window's start, and a Claude Code process per Fin.
 */
export const DISPLAY_TTL_MS = 6 * 60 * 60_000
/**
 * A failed discovery is held only briefly at first: a `cursor/list_available_models`
 * that timed out under load once answered "Model unavailable" for half a
 * minute after the CLI would have listed them in three seconds. Each failure
 * after it doubles the hold, up to `FAILED_DISCOVERY_MAX_MS`: a Claude
 * discovery that kept timing out ran a whole Claude Code process for 30 s
 * fifteen times in eleven minutes.
 */
export const FAILED_DISCOVERY_TTL_MS = 5_000
export const FAILED_DISCOVERY_MAX_MS = 10 * 60_000
/** A person's ask (the picker opening) within this of the folder's last discovery is answered by it. */
export const ASKED_AGAIN_MS = 60_000

/**
 * `display` and `send` answer from what is held and refresh behind it when it is due; `asked` is a person asking
 * (the picker opening), which discovers unless the folder just was; `refresh` always discovers; `held` never does.
 */
type Mode = "display" | "asked" | "refresh" | "send" | "held"

/** One folder of one account: `key` is the folder's own, `account` the prefix every folder of the account shares. */
interface ProfileScope {
  loader: ProviderProfileLoader
  env: NodeJS.ProcessEnv
  key: string
  account: string
  /** The folder discovery runs in, resolved; none for the account's own scope or a folder that is gone. */
  folder: string | undefined
  /** The folder as it was asked for, which is how its events are addressed. */
  cwd: string | undefined
}

/** What one folder's discovery last reported. */
interface FolderProfile {
  account: string
  profile: HarnessProfile
  loadedAt: number
  /** Set while the folder's last discovery failed: when it may run again. */
  retryAt?: number
}

/** The models an account lists, whichever folder they were read in. */
interface AccountModels {
  harness: string
  /** The list alone (`accountCatalog`). */
  profile: HarnessProfile
  loadedAt: number
  staleAt: number
  /** The runtime it was read from, where the harness names one (`ProviderProfileLoader.runtimeStamp`). */
  stamp?: string
}

/** What answers a read, and whether a refresh of it is due. */
interface Answer {
  profile: HarnessProfile
  loadedAt: number
  due: boolean
  /** The account's list in a folder it was never discovered in. */
  borrowed: boolean
  /** The folder's last discovery failed and this is what stood before it, or the failure itself. */
  failed: boolean
}

/**
 * Every harness's models and settings as this host discovered them.
 *
 * Discovery spawns each provider's CLI, so it is not what a read costs: a
 * read answers from what is held (memory, then the last snapshot on disk,
 * then the account's list from another folder, then a pending placeholder),
 * and a discovery runs only when nothing is held, when what is held is past
 * `DISPLAY_TTL_MS`, when a person asks (`get` with `force`), or when the
 * runtime, the account or a connection changed. Its result reports through
 * `onProfile`.
 *
 * The model list belongs to the account and is kept once for it; a folder
 * keeps only what its own configuration decides (`settings`,
 * `configuredModel`), so a folder the account was never discovered in lists
 * the account's models with Mako's defaults and starts nothing.
 */
export class HarnessProfiles {
  private readonly cache = new Map<string, FolderProfile>()
  private readonly catalogs = new Map<string, AccountModels>()
  /** Consecutive failed discoveries of each folder, which lengthen its hold. */
  private readonly failures = new Map<string, number>()
  private readonly loading = new Map<string, Promise<HarnessProfile>>()
  private readonly launching = new Map<string, Promise<HarnessProfile>>()
  /** Discoveries in flight for each account: one of them refreshes the list for all its folders. */
  private readonly discovering = new Map<string, number>()
  private readonly discoveryOwners = new Map<AbortController, { provider: string; settled: Promise<void> }>()
  /** Runtime refresh invalidates in-flight discovery, not only cached results. */
  private readonly revisions = new Map<string, number>()
  /** The folder each cache key was asked for, as it was asked: where its events are addressed. */
  private readonly scopes = new Map<string, string | undefined>()
  /** The folder each harness was last read in, which is where a change to its runtime is discovered. */
  private readonly lastFolder = new Map<string, string>()
  private readonly listeners = new Set<(event: HarnessProfileEvent) => void>()
  private closing = false
  private stopping: Promise<void> | undefined
  private readonly host: Pick<ProviderHost, "profiles" | "accounts">
  /** The last working snapshot of each account, and each folder's own defaults, answered before discovery runs. */
  private readonly store: ProviderProfileCache
  /** Held while a person waits on a start: a discovery nobody waits for starts once it is free. */
  private readonly foreground: Pick<Foreground, "idle"> | undefined

  constructor(host: Pick<ProviderHost, "profiles" | "accounts">, store: ProviderProfileCache, foreground?: Pick<Foreground, "idle">) {
    this.host = host
    this.store = store
    this.foreground = foreground
  }

  onProfile(listener: (event: HarnessProfileEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * One harness in `cwd`. What is held answers and is refreshed behind the answer once it is due; only a harness
   * with nothing held waits for its discovery. `force` is a person asking: it discovers and answers with that.
   */
  get(harness: string, force = false, cwd?: string): Promise<HarnessProfile> {
    return this.loadProfile(harness, cwd, force ? "asked" : "display")
  }

  /** Every provider, resolved. Hosts that filter on availability wait for a harness with nothing held. */
  all(force = false, cwd?: string): Promise<HarnessProfile[]> {
    return Promise.all(this.host.profiles.list().map((loader) => this.get(loader.provider, force, cwd)))
  }

  /**
   * Every provider as it is held, starting no discovery: what a window paints at its start and the heartbeat counts.
   * A profile past its freshness says `stale`; a harness with nothing held is a pending placeholder.
   */
  snapshots(cwd?: string): Promise<HarnessProfile[]> {
    return Promise.all(this.host.profiles.list().map((loader) =>
      this.loadProfile(loader.provider, cwd, "held").catch(() => pendingProviderProfile(loader))))
  }

  /**
   * The newest catalog this host holds for `harness` in memory, from any workspace, without discovering: what a row
   * reads its labels from. Undefined until one was read.
   */
  held(harness: string): HarnessProfile | undefined {
    let newest: { profile: HarnessProfile; loadedAt: number } | undefined
    for (const [key, entry] of this.cache)
      if (key.startsWith(`${harness}:`) && entry.profile.available && entry.profile.models.length && (!newest || entry.loadedAt > newest.loadedAt)) newest = entry
    for (const entry of this.catalogs.values())
      if (entry.harness === harness && entry.profile.models.length && (!newest || entry.loadedAt > newest.loadedAt)) newest = entry
    return newest?.profile
  }

  /** Sending validates the selection against what is held; discovery is not a per-turn tax. */
  forSend(harness: string, cwd?: string): Promise<HarnessProfile> {
    return this.loadProfile(harness, cwd, "send")
  }

  /**
   * The provider's models may have changed under its catalog: its runtime (an
   * update Mako ran, or one the user ran in a terminal), or a connection it
   * reaches models through. Its list is read again once, in the folder it was
   * last read in, and every folder of the account takes the new list as an
   * event; what is held answers until then, so a picker never blanks and a
   * new CLI's models arrive without a restart. Before this, an updated Codex
   * kept serving the old CLI's model list for the rest of the host's life.
   * It once discovered every folder that had listed the models, which on a
   * host thirty folders old was thirty CLI processes for one list.
   */
  async refresh(harness: string): Promise<void> {
    this.assertDiscoveryAdmission()
    const prefix = `${harness}:`
    this.revisions.set(harness, this.revision(harness) + 1)
    for (const [owner, entry] of this.discoveryOwners)
      if (entry.provider === harness) owner.abort(new Error("Provider discovery was superseded by a runtime refresh."))
    for (const key of this.loading.keys()) if (key.startsWith(prefix)) this.loading.delete(key)
    for (const key of this.launching.keys()) if (key.startsWith(prefix)) this.launching.delete(key)
    for (const [account, held] of this.catalogs)
      if (held.harness === harness) this.catalogs.set(account, { ...held, staleAt: 0 })
    await this.loadProfile(harness, this.lastFolder.get(harness), "refresh").catch(() => undefined)
  }

  /** Join even superseded queries removed from the display/send maps. Their
   * native cleanup must finish before the host disposes its backing stores. */
  stop(timeoutMs = 30_000): Promise<void> {
    this.closing = true
    if (this.stopping) return this.stopping
    const owned = [...this.discoveryOwners.entries()]
    const startedAt = performance.now()
    hostLog("discovery", "shutdown drain started", { queries: owned.length, providers: new Set(owned.map(([, entry]) => entry.provider)).size })
    for (const [owner] of owned) owner.abort(new Error("Mako's profile discovery is shutting down."))
    const drain = drainOwnedWork(owned.map(([, entry]) => entry.settled), timeoutMs, "Profile discovery shutdown did not complete.")
      .then(() => { hostLog("discovery", "shutdown drain completed", { elapsedMs: performance.now() - startedAt, queries: owned.length }) })
      .catch(error => {
        hostWarn("discovery", "shutdown drain refused", { elapsedMs: performance.now() - startedAt, queries: this.discoveryOwners.size })
        throw error
      })
      .finally(() => { if (this.stopping === drain) this.stopping = undefined })
    this.stopping = drain
    return drain
  }

  async resolveLaunch(harness: string, cwd: string | undefined, tuning: SessionSettings | undefined): Promise<SessionSettings | undefined> {
    if (!tuning?.model) return tuning
    if (this.host.profiles.get(harness)?.nativeModelIds && !Object.keys(tuning.options ?? {}).length) return tuning
    const profile = await this.forSend(harness, cwd)
    // A send needs the catalogue, not this minute's defaults. A profile whose
    // refresh failed or whose defaults went unreported still lists the models
    // the selection is validated against; the provider itself rejects a model
    // the account has since lost. Cursor's model listing is a network call to
    // its API, and a stall there once refused every send for 30 s at a time.
    if (!profile.available || !profile.models.length) {
      const reason = profile.error ?? profile.configurationError ?? `${profile.label} model discovery is unavailable. Refresh its settings before sending.`
      hostWarn("discovery", "send refused", { harness, model: tuning.model, error: reason })
      throw new Error(reason)
    }
    if (profile.configurationError)
      hostWarn("discovery", "send used the last discovered catalogue", { harness, model: tuning.model, error: profile.configurationError })
    try {
      return resolveHarnessTuning(profile, tuning)
    } catch (error) {
      // The catalogue refused the selection, and it may be the catalogue that is old: the send fails now, and the
      // harness is asked again behind it so the picker and the next send read what it lists today.
      void this.loadProfile(harness, cwd, "asked").catch(() => undefined)
      throw error
    }
  }

  /**
   * A selection made on another harness, as this one lists it: its model by this catalog's own identity (another
   * harness's encoding of it, `claude-opus-5-5[context=1m,fast=false]`, by the model it names), with only the options
   * that model has and values it takes. A model this catalog doesn't list goes as nothing, so the harness runs its
   * own default rather than refusing every send. With no catalog to hold it to, only a model another harness encoded
   * is dropped. Undefined in, undefined out.
   */
  async carried(harness: string, cwd: string | undefined, tuning: SessionSettings | undefined): Promise<SessionSettings | undefined> {
    if (!tuning?.model) return tuning
    const profile = await this.forSend(harness, cwd).catch(() => undefined)
    const fit = carriedTuning(profile?.available ? profile.models : undefined, tuning)
    if (fit?.model !== tuning.model)
      hostLog("discovery", "a carried model was fitted to its harness", { harness, model: tuning.model, ...(fit?.model && { to: fit.model }) })
    return fit
  }

  /**
   * The settings a headless run is built from: the same validated selection a
   * live session receives, plus the catalog's defaults for the runner to read.
   */
  async resolveNativeLaunch(harness: string, cwd: string | undefined, tuning: SessionSettings | undefined): Promise<NativeRunOptions | undefined> {
    const settings = await this.resolveLaunch(harness, cwd, tuning)
    if (!settings?.model) return settings
    const profile = await this.forSend(harness, cwd)
    return profile.available ? withCatalogDefaults(profile, settings) : settings
  }

  private assertDiscoveryAdmission(): void {
    if (this.closing) throw new Error("Mako's profile discovery is shutting down. No new query was started.")
  }

  private revision(harness: string): number {
    return this.revisions.get(harness) ?? 0
  }

  private assertRevision(harness: string, revision: number): void {
    this.assertDiscoveryAdmission()
    if (this.revision(harness) !== revision)
      throw new Error("Provider discovery was superseded by a runtime refresh. Retry with the current runtime.")
  }

  private async scopeOf(loader: ProviderProfileLoader, cwd: string | undefined, revision: number): Promise<ProfileScope> {
    const harness = loader.provider
    const env = await this.host.accounts.env(harness, process.env)
    this.assertRevision(harness, revision)
    const accountKey = loader.cacheKey(env)
    let folder = cwd
    if (cwd) {
      try {
        folder = await realpath(cwd)
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR"))
          throw error
        // A deleted folder lists the account's models: discovery cannot start
        // there, and a picker still open on it retried every two minutes forever.
        folder = undefined
      }
    }
    const account = `${harness}:${accountKey}:`
    this.assertRevision(harness, revision)
    return { loader, env, account, key: `${account}${folder ?? ""}`, folder, cwd }
  }

  private async loadProfile(harness: string, cwd: string | undefined, mode: Mode): Promise<HarnessProfile> {
    this.assertDiscoveryAdmission()
    const loader = this.host.profiles.get(harness)
    if (!loader) return unknownProviderProfile(harness, "Unknown provider")
    const revision = this.revision(harness)
    const scope = await this.scopeOf(loader, cwd, revision)
    const { key } = scope
    this.scopes.set(key, cwd)
    if (cwd && mode !== "held") this.lastFolder.set(harness, cwd)
    if (mode === "refresh") return this.loading.get(key) ?? this.startLoad(scope, true)
    const held = await this.answer(scope)
    this.assertRevision(harness, revision)
    if (mode === "held") {
      if (!held) return pendingProviderProfile(loader)
      return held.due ? { ...held.profile, stale: true } : held.profile
    }
    const usable = held !== undefined && held.profile.available && held.profile.models.length > 0
    if (mode === "asked") {
      // Opening the picker twice in a minute reads the harness once.
      if (held && usable && !held.borrowed && !held.failed && Date.now() - held.loadedAt < ASKED_AGAIN_MS) return held.profile
      return this.loading.get(key) ?? this.startLoad(scope, false)
    }
    if (mode === "send" && held?.borrowed && usable && scope.folder && this.folderDecides(loader, held.profile)) {
      // The account's list validates the send, but this harness launches on what the folder itself configures, and
      // nothing of this folder is held. Mako's defaults in its place would start a project on a model it didn't choose.
      const own = await this.folderFields(scope, held.profile)
      this.assertRevision(harness, revision)
      if (own) {
        // A lent answer is another folder's reading of the same files: this folder's own is read behind the send.
        if (own.lent && !this.discovering.get(scope.account)) this.startLoad(scope, true)
        return own.profile
      }
      return this.loading.get(key) ?? this.startLoad(scope, false)
    }
    // Stale beats blank, for a picker and for a send alike: the catalogue
    // answers at once, and the refresh behind it lands as an event. A send
    // validates against what is held, and its next one against what landed.
    if (held && (usable || mode === "display")) {
      if (held.due && !this.discovering.get(scope.account)) this.startLoad(scope, true)
      return held.profile
    }
    // A harness that just failed or said it is unavailable is the answer for
    // a moment, not for the whole hold: a person sending again later is
    // reason enough to ask it again.
    if (held && Date.now() - held.loadedAt < (held.failed ? FAILED_DISCOVERY_TTL_MS : ASKED_AGAIN_MS)) return held.profile
    if (mode === "send" && loader.loadForSend) {
      // The whole profile is read behind the send so the next one finds it held.
      if (!this.discovering.get(scope.account) && (!held || held.due)) this.startLoad(scope, true)
      const pending = this.launching.get(key)
      if (pending) return pending
      const owner = new AbortController()
      const settled = ownedWorkCompletion()
      this.discoveryOwners.set(owner, { provider: harness, settled: settled.promise })
      const request = Promise.resolve()
        .then(() => { this.assertRevision(harness, revision); return loader.loadForSend!(scope.env, scope.folder, { signal: owner.signal }) })
        .then(profile => { this.assertRevision(harness, revision); return profile })
        .finally(() => { this.discoveryOwners.delete(owner); settled.resolve(); if (this.launching.get(key) === request) this.launching.delete(key) })
      this.launching.set(key, request)
      return request
    }
    return this.loading.get(key) ?? this.startLoad(scope, false)
  }

  /**
   * What is held for the folder: what its own discovery reported (memory, then the snapshot on disk), else the
   * account's list as another folder read it.
   */
  private async answer(scope: ProfileScope): Promise<Answer | undefined> {
    let own = this.cache.get(scope.key)
    if (!own) {
      const kept = await this.store.get(scope.account, scope.key)
      own = this.cache.get(scope.key)
      if (!own && kept?.profile.available) {
        own = { account: scope.account, profile: this.current(kept.profile), loadedAt: kept.savedAt }
        this.cache.set(scope.key, own)
      }
    }
    const models = await this.accountModels(scope)
    const now = Date.now()
    const failed = own?.retryAt !== undefined
    // A folder's own defaults are read again when a person asks, never on a clock; the list they sit on is.
    const due = failed ? now >= (own?.retryAt ?? 0) : !models || now >= models.staleAt
    const listed = models?.profile.available === true && models.profile.models.length > 0
    if (own && ((own.profile.available && own.profile.models.length > 0) || !listed))
      return { profile: own.profile, loadedAt: own.loadedAt, due, borrowed: false, failed }
    if (!models || !listed) return undefined
    // Models belong to the account. What the folder's own configuration
    // decides (the harness's defaults there, its configured model) is never
    // another folder's: it stays unknown, and Mako's own defaults stand in.
    return { profile: this.current(models.profile), loadedAt: own?.loadedAt ?? models.loadedAt, due, borrowed: true, failed }
  }

  /** Whether this harness's profile says anything of the folder's own configuration, given the models it lists. */
  private folderDecides(loader: ProviderProfileLoader, listed: HarnessProfile): boolean {
    if (!loader.folder) return false
    // Where Mako's default is offered it is the profile's `settings` in every folder (`availableProviderProfile`).
    return loader.folder.configuredModel === true || workDefault(loader.defaults, listed.models) === undefined
  }

  /**
   * What `scope`'s folder configures, without a discovery: parsed by the loader where it can, else lent by a folder
   * of the same repository and account whose project configuration is the same bytes. Undefined when neither can
   * say, and the send waits for the folder's own discovery.
   */
  private async folderFields(scope: ProfileScope, listed: HarnessProfile): Promise<{ profile: HarnessProfile; lent: boolean } | undefined> {
    const { loader, folder } = scope
    if (!loader.folder || !folder) return undefined
    const withFields = (fields: FolderDefaults): HarnessProfile => {
      const profile: HarnessProfile = { ...accountCatalog(listed), ...fields }
      if (profile.settings?.model && !profile.models.some((model) => model.id === profile.settings?.model)) delete profile.settings
      return this.current(profile)
    }
    const parsed = await loader.folder.read?.(scope.env, folder, listed.models).catch(() => undefined)
    if (parsed) return { profile: withFields(parsed), lent: false }
    const lenders = new Map<string, FolderDefaults>()
    for (const [key, entry] of this.cache) {
      if (entry.account !== scope.account || entry.retryAt !== undefined || key.length === scope.account.length) continue
      if (!entry.profile.available || entry.profile.configurationError) continue
      lenders.set(key.slice(scope.account.length), {
        ...(entry.profile.settings && { settings: entry.profile.settings }),
        ...(entry.profile.configuredModel !== undefined && { configuredModel: entry.profile.configuredModel }),
      })
    }
    for (const kept of await this.store.folders(scope.account))
      if (!lenders.has(kept.folder)) lenders.set(kept.folder, kept.fields)
    for (const [lender, fields] of lenders)
      if (lender !== folder && await sameProjectConfiguration(folder, lender, loader.folder.files)) return { profile: withFields(fields), lent: true }
    return undefined
  }

  /** The account's list: what this host last read, else the newer of that and the snapshot on disk. */
  private async accountModels(scope: Pick<ProfileScope, "account" | "loader">): Promise<AccountModels | undefined> {
    const kept = await this.store.catalog(scope.account)
    const held = this.catalogs.get(scope.account)
    if (!kept?.profile.available || (held && held.loadedAt >= kept.savedAt)) return held
    // An earlier discovery this host invalidated (`refresh`) stays due whatever the file says of its age.
    const staleAt = held?.staleAt === 0 ? 0 : kept.savedAt + DISPLAY_TTL_MS
    const models: AccountModels = { harness: scope.loader.provider, profile: kept.profile, loadedAt: kept.savedAt, staleAt }
    if (kept.stamp !== undefined) models.stamp = kept.stamp
    this.catalogs.set(scope.account, models)
    return models
  }

  /**
   * The last models this account and workspace listed: what memory holds (a
   * previous failure already carries them), then the snapshot on disk, then
   * another workspace of the same account.
   */
  private async lastDiscoveredProfile(scope: ProfileScope): Promise<HarnessProfile | null> {
    const held = await this.answer(scope)
    return held?.profile.available && held.profile.models.length ? held.profile : null
  }

  /** A saved snapshot with this release's defaults; an earlier release saved its own. */
  private current(profile: HarnessProfile): HarnessProfile {
    const loader = this.host.profiles.get(profile.id)
    return loader ? withWorkDefault(profile, loader.defaults) : profile
  }

  /** How long a folder's discovery is left alone after its `count`th failure in a row. */
  private failureHold(count: number): number {
    return Math.min(FAILED_DISCOVERY_TTL_MS * 2 ** Math.max(0, count - 1), FAILED_DISCOVERY_MAX_MS)
  }

  /**
   * The account's list as `scope`'s discovery just read it, in every other folder of the account this host holds:
   * each keeps what its own configuration decided and hears the new models as an event.
   */
  private shareModels(scope: ProfileScope, models: AccountModels): void {
    for (const [key, entry] of this.cache) {
      if (key === scope.key || entry.account !== scope.account) continue
      const before = entry.profile
      let next: HarnessProfile = { ...before, ...models.profile }
      if (models.profile.defaultModel === undefined) delete next.defaultModel
      delete next.error
      // A failure there was a failure to read this list, which has now been read.
      if (entry.retryAt !== undefined) delete next.configurationError
      if (next.settings?.model && !next.models.some((model) => model.id === next.settings?.model)) delete next.settings
      next = this.current(next)
      this.cache.set(key, { account: entry.account, profile: next, loadedAt: entry.loadedAt })
      this.failures.delete(key)
      if (JSON.stringify(next) === JSON.stringify(before)) continue
      const event: HarnessProfileEvent = { profile: next }
      const cwd = this.scopes.get(key)
      if (cwd !== undefined) event.cwd = cwd
      for (const listener of this.listeners) listener(event)
    }
  }

  /**
   * Runs the folder's discovery. One that nobody waits for (`behind` an answer already given, or a change to the
   * runtime) starts once the host's foreground is free, so it never shares the machine with a harness starting.
   */
  private startLoad(scope: ProfileScope, behind: boolean): Promise<HarnessProfile> {
    const { key, loader, env } = scope
    const revision = this.revision(loader.provider)
    const owner = new AbortController()
    const settled = ownedWorkCompletion()
    this.discoveryOwners.set(owner, { provider: loader.provider, settled: settled.promise })
    this.discovering.set(scope.account, (this.discovering.get(scope.account) ?? 0) + 1)
    const request = (async () => {
      let profile: HarnessProfile
      let failed = false
      let stamp: string | undefined
      try {
        if (behind) await this.foreground?.idle()
        this.assertRevision(loader.provider, revision)
        owner.signal.throwIfAborted()
        stamp = await loader.runtimeStamp?.(env).catch(() => undefined)
        const known = stamp === undefined ? undefined : await this.accountModels(scope)
        const context: ProfileLoadContext = { signal: owner.signal }
        // What the harness said of each model under this runtime and account still stands: it is not asked again.
        if (known && known.stamp === stamp) context.kept = known.profile.models
        profile = await loader.load(env, scope.folder, context)
      } catch (error) {
        this.assertRevision(loader.provider, revision)
        failed = true
        const message = error instanceof Error ? error.message : String(error)
        // The models an account had a minute ago are still its models; the
        // picker keeps them and says the refresh failed, and a send validates
        // against them while the refresh is retried behind it.
        const last = await this.lastDiscoveredProfile(scope)
        profile = last
          ? { ...last, pending: false, configurationError: `${message} Showing the last discovered settings.` }
          : unavailableProviderProfile(loader, message)
      }
      this.assertRevision(loader.provider, revision)
      const loadedAt = Date.now()
      if (failed) {
        const count = (this.failures.get(key) ?? 0) + 1
        this.failures.set(key, count)
        this.cache.set(key, { account: scope.account, profile, loadedAt, retryAt: loadedAt + this.failureHold(count) })
      } else {
        this.failures.delete(key)
        this.cache.set(key, { account: scope.account, profile, loadedAt })
      }
      // Only a working profile is worth answering with before discovery runs;
      // a transient failure must not greet the next launch as fact, and is
      // never the account's list.
      if (!failed) {
        const models: AccountModels = { harness: loader.provider, profile: accountCatalog(profile), loadedAt, staleAt: loadedAt + DISPLAY_TTL_MS }
        if (stamp !== undefined) models.stamp = stamp
        this.catalogs.set(scope.account, models)
        if (profile.available) {
          this.shareModels(scope, models)
          await this.store.put(scope.account, key, profile, stamp).catch(() => {})
        } else {
          // The harness answered that this account lists nothing (signed out): the list kept for it would greet the
          // next host as its models, with no discovery at a window's start to correct it.
          await this.store.clear(scope.account).catch(() => {})
        }
      }
      this.assertRevision(loader.provider, revision)
      const event: HarnessProfileEvent = { profile }
      if (scope.cwd !== undefined) event.cwd = scope.cwd
      for (const listener of this.listeners) listener(event)
      return profile
    })().finally(() => {
      this.discoveryOwners.delete(owner)
      settled.resolve()
      if (this.loading.get(key) === request) this.loading.delete(key)
      const others = (this.discovering.get(scope.account) ?? 1) - 1
      if (others > 0) this.discovering.set(scope.account, others)
      else this.discovering.delete(scope.account)
    })
    this.loading.set(key, request)
    // Callers that answer from a snapshot never observe this promise.
    request.catch(() => {})
    return request
  }
}

import { realpath } from "node:fs/promises"
import { resolveHarnessTuning, withCatalogDefaults } from "./harness-models.js"
import type { NativeRunOptions } from "./providers/native-runner.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { ProviderHost } from "./providers/host.js"
import {
  pendingProviderProfile,
  unavailableProviderProfile,
  unknownProviderProfile,
  withWorkDefault,
  type ProviderProfileLoader,
} from "./providers/profile-loader.js"
import type { HarnessProfile } from "@mako/host/contracts/providers-acp"
import type { ProviderProfileCache } from "./provider-profile-cache.js"
import { hostLog, hostWarn } from "@mako/host/base/host-log"
import { drainOwnedWork, ownedWorkCompletion } from "@mako/host/base/owned-work"

export interface HarnessProfileEvent {
  profile: HarnessProfile
  cwd?: string
}

const DISPLAY_TTL_MS = 30_000
/**
 * A failed discovery is held only briefly: a `cursor/list_available_models`
 * that timed out under load once answered "Model unavailable" for half a
 * minute after the CLI would have listed them in three seconds.
 */
export const FAILED_DISCOVERY_TTL_MS = 5_000

type Mode = "display" | "refresh" | "send" | "now"

/** One discovery's cache key and the prefix shared by the account's workspaces. */
type ProfileScope = { key: string; account: string }

/**
 * Every harness's models and settings as this host discovered them.
 *
 * Discovery spawns each provider's CLI, and the slowest one used to gate the
 * whole list: the picker showed two agents until every probe had answered.
 * Now a request answers from what is already known — memory, then the last
 * snapshot on disk, then a pending placeholder — while the real load runs
 * behind it and reports through `onProfile`.
 */
export class HarnessProfiles {
  private readonly cache = new Map<string, { profile: HarnessProfile; loadedAt: number; staleAt: number }>()
  private readonly loading = new Map<string, Promise<HarnessProfile>>()
  private readonly launching = new Map<string, Promise<HarnessProfile>>()
  private readonly discoveryOwners = new Map<AbortController, { provider: string; settled: Promise<void> }>()
  /** Runtime refresh invalidates in-flight discovery, not only cached results. */
  private readonly revisions = new Map<string, number>()
  /** The workspace each cache key was asked for, so a provider can be re-discovered everywhere it was seen. */
  private readonly scopes = new Map<string, string | undefined>()
  private readonly listeners = new Set<(event: HarnessProfileEvent) => void>()
  private closing = false
  private stopping: Promise<void> | undefined
  private readonly host: Pick<ProviderHost, "profiles" | "accounts">
  /** The last working snapshot of each account and workspace, answered before discovery runs. */
  private readonly store: ProviderProfileCache

  constructor(host: Pick<ProviderHost, "profiles" | "accounts">, store: ProviderProfileCache) {
    this.host = host
    this.store = store
  }

  onProfile(listener: (event: HarnessProfileEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(harness: string, force = false, cwd?: string): Promise<HarnessProfile> {
    return this.loadProfile(harness, cwd, force ? "refresh" : "display")
  }

  /** Every provider, resolved. Hosts that filter on availability wait for discovery. */
  all(force = false, cwd?: string): Promise<HarnessProfile[]> {
    return Promise.all(this.host.profiles.list().map((loader) => this.get(loader.provider, force, cwd)))
  }

  /** Every provider, immediately: what is known now, with discovery reporting behind it. */
  now(cwd?: string): HarnessProfile[] {
    return this.host.profiles.list().map((loader) => {
      void this.loadProfile(loader.provider, cwd, "now")
        .then((profile) => {
          if (!this.closing && !profile.pending)
            for (const listener of this.listeners) listener({ profile, cwd })
        })
        .catch(() => {})
      return pendingProviderProfile(loader)
    })
  }

  /** Sending validates the selection already shown; discovery is not a per-turn tax. */
  forSend(harness: string, cwd?: string): Promise<HarnessProfile> {
    return this.loadProfile(harness, cwd, "send")
  }

  /**
   * The provider's runtime changed under its catalog — an update Mako ran, or
   * one the user ran in a terminal — so every workspace that listed its models
   * lists them again. What is held answers until each discovery lands as an
   * event; a picker never blanks, and a new CLI's models arrive without a
   * restart. Before this, an updated Codex kept serving the old CLI's model
   * list for the rest of the host's life.
   */
  async refresh(harness: string): Promise<void> {
    this.assertDiscoveryAdmission()
    const prefix = `${harness}:`
    this.revisions.set(harness, this.revision(harness) + 1)
    for (const [owner, entry] of this.discoveryOwners)
      if (entry.provider === harness) owner.abort(new Error("Provider discovery was superseded by a runtime refresh."))
    for (const key of this.loading.keys()) if (key.startsWith(prefix)) this.loading.delete(key)
    for (const key of this.launching.keys()) if (key.startsWith(prefix)) this.launching.delete(key)
    const workspaces = new Set<string | undefined>()
    for (const [key, cwd] of this.scopes) if (key.startsWith(prefix)) workspaces.add(cwd)
    for (const [key, held] of this.cache)
      if (key.startsWith(prefix)) this.cache.set(key, { ...held, staleAt: 0 })
    if (!workspaces.size) workspaces.add(undefined)
    await Promise.all([...workspaces].map((cwd) => this.loadProfile(harness, cwd, "refresh").catch(() => undefined)))
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
    return resolveHarnessTuning(profile, tuning)
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

  private async loadProfile(harness: string, cwd: string | undefined, mode: Mode): Promise<HarnessProfile> {
    this.assertDiscoveryAdmission()
    const loader = this.host.profiles.get(harness)
    if (!loader) return unknownProviderProfile(harness, "Unknown provider")
    const revision = this.revision(harness)
    const env = await this.host.accounts.env(harness, process.env)
    this.assertRevision(harness, revision)
    const accountKey = loader.cacheKey(env)
    let scope = cwd
    if (cwd) {
      try {
        scope = await realpath(cwd)
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR"))
          throw error
        // A deleted folder lists the account's models: discovery cannot start
        // there, and a picker still open on it retried every two minutes forever.
        scope = undefined
      }
    }
    const account = `${harness}:${accountKey}:`
    this.assertRevision(harness, revision)
    const key = `${account}${scope ?? ""}`
    this.scopes.set(key, cwd)
    const held = this.cache.get(key)
    if (mode !== "refresh" && held) {
      const fresh = Date.now() < held.staleAt
      if (fresh) return held.profile
      if (mode === "send" && held.profile.available && held.profile.models.length) {
        // The catalogue validates the send at once. One that came from a failed
        // refresh is retried behind the send so it heals; a plain expired one
        // waits for the next display refresh, since discovery is not a
        // per-turn tax.
        if (held.profile.configurationError && !this.loading.has(key))
          this.startLoad(loader, { key, account }, env, scope, cwd)
        return held.profile
      }
    }
    if (mode === "send" && loader.loadForSend) {
      const pending = this.launching.get(key)
      if (pending) return pending
      const owner = new AbortController()
      const settled = ownedWorkCompletion()
      this.discoveryOwners.set(owner, { provider: harness, settled: settled.promise })
      const request = Promise.resolve()
        .then(() => { this.assertRevision(harness, revision); return loader.loadForSend!(env, scope, { signal: owner.signal }) })
        .then(profile => { this.assertRevision(harness, revision); return profile })
        .finally(() => { this.discoveryOwners.delete(owner); settled.resolve(); if (this.launching.get(key) === request) this.launching.delete(key) })
      this.launching.set(key, request)
      return request
    }
    const request = this.loading.get(key) ?? this.startLoad(loader, { key, account }, env, scope, cwd)
    if (mode === "display" || mode === "now") {
      // Stale beats blank: the refresh lands as an event moments later.
      const snapshot = held?.profile ?? this.current(await this.store.get(key))
      this.assertRevision(harness, revision)
      if (snapshot) return snapshot
      // A workspace this account has not been seen in yet still has the
      // account's models: the picker and a saved choice render at once, and
      // only the workspace's own defaults wait for discovery.
      const borrowed = await this.accountSnapshot(account)
      this.assertRevision(harness, revision)
      // Discovery may have finished while the caches were read. `now` callers
      // re-emit what they get and `startLoad` has already reported it.
      const landed = this.cache.get(key)
      if (landed && mode !== "now") return landed.profile
      if (borrowed) return borrowed
      if (mode === "now") return pendingProviderProfile(loader)
    }
    return request
  }

  /**
   * The last models this account and workspace listed: what memory holds (a
   * previous failure already carries them), then the snapshot on disk, then
   * another workspace of the same account.
   */
  private async lastDiscoveredProfile(scope: ProfileScope): Promise<HarnessProfile | null> {
    const held = this.cache.get(scope.key)?.profile
    if (held?.available && held.models.length) return held
    const stored = this.current(await this.store.get(scope.key))
    if (stored?.available && stored.models.length) return stored
    const borrowed = await this.accountSnapshot(scope.account)
    return borrowed?.models.length ? borrowed : null
  }

  /** A saved snapshot with this release's defaults; an earlier release saved its own. */
  private current(profile: HarnessProfile | null): HarnessProfile | null {
    const loader = profile && this.host.profiles.get(profile.id)
    return profile && loader ? withWorkDefault(profile, loader.defaults) : profile
  }

  private async accountSnapshot(prefix: string): Promise<HarnessProfile | null> {
    let held: { loadedAt: number; profile: HarnessProfile } | null = null
    for (const [key, entry] of this.cache) {
      if (!key.startsWith(prefix)) continue
      if (!entry.profile.available || entry.profile.configurationError) continue
      if (!held || entry.loadedAt > held.loadedAt) held = entry
    }
    const source = held?.profile ?? this.current(await this.store.nearest(prefix))
    if (!source) return null
    // Models belong to the account; defaults and the
    // configured model can differ per workspace, so they stay unknown.
    const borrowed: HarnessProfile = {
      id: source.id,
      label: source.label,
      available: source.available,
      transport: source.transport,
      models: source.models,
      pending: true,
    }
    if (source.defaultModel !== undefined) borrowed.defaultModel = source.defaultModel
    return borrowed
  }

  private startLoad(
    loader: ProviderProfileLoader,
    scope: ProfileScope,
    env: NodeJS.ProcessEnv,
    cwd: string | undefined,
    reportedCwd: string | undefined
  ): Promise<HarnessProfile> {
    const { key } = scope
    const revision = this.revision(loader.provider)
    const owner = new AbortController()
    const settled = ownedWorkCompletion()
    this.discoveryOwners.set(owner, { provider: loader.provider, settled: settled.promise })
    const request = (async () => {
      let profile: HarnessProfile
      let failed = false
      try {
        profile = await loader.load(env, cwd, { signal: owner.signal })
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
      this.cache.set(key, { profile, loadedAt, staleAt: loadedAt + (failed ? FAILED_DISCOVERY_TTL_MS : DISPLAY_TTL_MS) })
      // Only a working profile is worth answering with before discovery runs;
      // a transient failure must not greet the next launch as fact.
      if (profile.available && !failed)
        await this.store.put(key, profile).catch(() => {})
      this.assertRevision(loader.provider, revision)
      const event: HarnessProfileEvent = { profile }
      if (reportedCwd !== undefined) event.cwd = reportedCwd
      for (const listener of this.listeners) listener(event)
      return profile
    })().finally(() => { this.discoveryOwners.delete(owner); settled.resolve(); if (this.loading.get(key) === request) this.loading.delete(key) })
    this.loading.set(key, request)
    // Callers that answer from a snapshot never observe this promise.
    request.catch(() => {})
    return request
  }
}

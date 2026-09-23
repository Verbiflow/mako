import { accountEnv } from "./accounts.js"
import { realpath } from "node:fs/promises"
import { resolveHarnessTuning, withCatalogDefaults } from "./harness-models.js"
import type { NativeRunOptions } from "./providers/native-runner.js"
import type { SessionSettings } from "@mako/sessions/settings"
import { providerHost } from "./providers/index.js"
import {
  pendingProviderProfile,
  unavailableProviderProfile,
  unknownProviderProfile,
  type ProviderProfileLoader,
} from "./providers/profile-loader.js"
import type { HarnessProfile } from "./shared.js"
import { providerProfileCache } from "./provider-profile-cache.js"
import { hostWarn } from "./host-log.js"

export { resolveHarnessTuning }
export { normalizeAcpOptions } from "@mako/sessions/model-catalog"
export { devinExecutable } from "./providers/devin/executable.js"
export {
  openCodeExecutable,
  resolveOpenCodeInstallation,
  verifyOpenCodeSession,
  type OpenCodeInstallation,
} from "./providers/opencode/installation.js"

export interface HarnessProfileEvent {
  profile: HarnessProfile
  cwd?: string
}

/**
 * Discovery spawns each provider's CLI, and the slowest one used to gate the
 * whole list: the picker showed two agents until every probe had answered.
 * Now a request answers from what is already known — memory, then the last
 * snapshot on disk, then a pending placeholder — while the real load runs
 * behind it and reports through `onHarnessProfile`.
 */
const cache = new Map<
  string,
  { profile: HarnessProfile; loadedAt: number; staleAt: number }
>()
const loading = new Map<string, Promise<HarnessProfile>>()
const launching = new Map<string, Promise<HarnessProfile>>()
/** The workspace each cache key was asked for, so a provider can be re-discovered everywhere it was seen. */
const scopes = new Map<string, string | undefined>()
const listeners = new Set<(event: HarnessProfileEvent) => void>()
const DISPLAY_TTL_MS = 30_000
/**
 * A failed discovery is held only briefly: a `cursor/list_available_models`
 * that timed out under load once answered "Model unavailable" for half a
 * minute after the CLI would have listed them in three seconds.
 */
export const FAILED_DISCOVERY_TTL_MS = 5_000

type Mode = "display" | "refresh" | "send" | "now"

export function onHarnessProfile(
  listener: (event: HarnessProfileEvent) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function harnessProfile(
  harness: string,
  force = false,
  cwd?: string
): Promise<HarnessProfile> {
  return loadProfile(harness, cwd, force ? "refresh" : "display")
}

/**
 * The provider's runtime changed under its catalog — an update Mako ran, or
 * one the user ran in a terminal — so every workspace that listed its models
 * lists them again. What is held answers until each discovery lands as an
 * event; a picker never blanks, and a new CLI's models arrive without a
 * restart. Before this, an updated Codex kept serving the old CLI's model
 * list for the rest of the host's life.
 */
export async function refreshHarnessProfiles(harness: string): Promise<void> {
  const prefix = `${harness}:`
  const workspaces = new Set<string | undefined>()
  for (const [key, cwd] of scopes) if (key.startsWith(prefix)) workspaces.add(cwd)
  for (const [key, held] of cache)
    if (key.startsWith(prefix)) cache.set(key, { ...held, staleAt: 0 })
  if (!workspaces.size) workspaces.add(undefined)
  await Promise.all(
    [...workspaces].map((cwd) =>
      loadProfile(harness, cwd, "refresh").catch(() => undefined)
    )
  )
}

/** Sending validates the selection already shown; discovery is not a per-turn tax. */
export function harnessProfileForSend(
  harness: string,
  cwd?: string
): Promise<HarnessProfile> {
  return loadProfile(harness, cwd, "send")
}

export async function resolveHarnessLaunch(
  harness: string,
  cwd: string | undefined,
  tuning: SessionSettings | undefined
): Promise<SessionSettings | undefined> {
  if (!tuning?.model) return tuning
  if (
    providerHost.profiles.get(harness)?.nativeModelIds &&
    !Object.keys(tuning.options ?? {}).length
  )
    return tuning
  const profile = await harnessProfileForSend(harness, cwd)
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
    hostWarn("discovery", "send used the last discovered catalogue", {
      harness,
      model: tuning.model,
      error: profile.configurationError,
    })
  return resolveHarnessTuning(profile, tuning)
}

/**
 * The settings a headless run is built from: the same validated selection a
 * live session receives, plus the catalog's defaults for the runner to read.
 */
export async function resolveNativeLaunch(
  harness: string,
  cwd: string | undefined,
  tuning: SessionSettings | undefined
): Promise<NativeRunOptions | undefined> {
  const settings = await resolveHarnessLaunch(harness, cwd, tuning)
  if (!settings?.model) return settings
  const profile = await harnessProfileForSend(harness, cwd)
  return profile.available ? withCatalogDefaults(profile, settings) : settings
}

async function loadProfile(
  harness: string,
  cwd: string | undefined,
  mode: Mode
): Promise<HarnessProfile> {
  const loader = providerHost.profiles.get(harness)
  if (!loader) return unknownProviderProfile(harness, "Unknown provider")
  const env = await accountEnv(harness, process.env)
  const accountKey = loader.cacheKey(env)
  let scope = cwd
  if (cwd) {
    try {
      scope = await realpath(cwd)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTDIR")
      )
        throw error
    }
  }
  const account = `${harness}:${accountKey}:`
  const key = `${account}${scope ?? ""}`
  scopes.set(key, cwd)
  const held = cache.get(key)
  if (mode !== "refresh" && held) {
    const fresh = Date.now() < held.staleAt
    if (fresh) return held.profile
    if (mode === "send" && held.profile.available && held.profile.models.length) {
      // The catalogue validates the send at once. One that came from a failed
      // refresh is retried behind the send so it heals; a plain expired one
      // waits for the next display refresh, since discovery is not a
      // per-turn tax.
      if (held.profile.configurationError && !loading.has(key))
        startLoad(loader, { key, account }, env, scope, cwd)
      return held.profile
    }
  }
  if (mode === "send" && loader.loadForSend) {
    const pending = launching.get(key)
    if (pending) return pending
    const request = loader
      .loadForSend(env, scope)
      .finally(() => launching.delete(key))
    launching.set(key, request)
    return request
  }
  const request =
    loading.get(key) ?? startLoad(loader, { key, account }, env, scope, cwd)
  if (mode === "display" || mode === "now") {
    // Stale beats blank: the refresh lands as an event moments later.
    const snapshot = held?.profile ?? (await providerProfileCache.get(key))
    if (snapshot) return snapshot
    // A workspace this account has not been seen in yet still has the
    // account's models: the picker and a saved choice render at once, and
    // only the workspace's own defaults wait for discovery.
    const borrowed = await accountSnapshot(account)
    // Discovery may have finished while the caches were read. `now` callers
    // re-emit what they get and `startLoad` has already reported it.
    const landed = cache.get(key)
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
async function lastDiscoveredProfile(
  scope: ProfileScope
): Promise<HarnessProfile | null> {
  const held = cache.get(scope.key)?.profile
  if (held?.available && held.models.length) return held
  const stored = await providerProfileCache.get(scope.key)
  if (stored?.available && stored.models.length) return stored
  const borrowed = await accountSnapshot(scope.account)
  return borrowed?.models.length ? borrowed : null
}

/** One discovery's cache key and the prefix shared by the account's workspaces. */
type ProfileScope = { key: string; account: string }

async function accountSnapshot(
  prefix: string
): Promise<HarnessProfile | null> {
  let held: { loadedAt: number; profile: HarnessProfile } | null = null
  for (const [key, entry] of cache) {
    if (!key.startsWith(prefix)) continue
    if (!entry.profile.available || entry.profile.configurationError) continue
    if (!held || entry.loadedAt > held.loadedAt) held = entry
  }
  const source = held?.profile ?? (await providerProfileCache.nearest(prefix))
  if (!source) return null
  // Models and capabilities belong to the account; defaults and the
  // configured model can differ per workspace, so they stay unknown.
  const borrowed: HarnessProfile = {
    id: source.id,
    label: source.label,
    available: source.available,
    transport: source.transport,
    models: source.models,
    capabilities: source.capabilities,
    pending: true,
  }
  if (source.defaultModel !== undefined) borrowed.defaultModel = source.defaultModel
  return borrowed
}

function startLoad(
  loader: ProviderProfileLoader,
  scope: ProfileScope,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  reportedCwd: string | undefined
): Promise<HarnessProfile> {
  const { key } = scope
  const request = (async () => {
    let profile: HarnessProfile
    let failed = false
    try {
      profile = await loader.load(env, cwd)
    } catch (error) {
      failed = true
      const message = error instanceof Error ? error.message : String(error)
      // The models an account had a minute ago are still its models; the
      // picker keeps them and says the refresh failed, and a send validates
      // against them while the refresh is retried behind it.
      const last = await lastDiscoveredProfile(scope)
      profile = last
        ? {
            ...last,
            pending: false,
            configurationError: `${message} Showing the last discovered settings.`,
          }
        : unavailableProviderProfile(loader, message)
    }
    const loadedAt = Date.now()
    cache.set(key, {
      profile,
      loadedAt,
      staleAt: loadedAt + (failed ? FAILED_DISCOVERY_TTL_MS : DISPLAY_TTL_MS),
    })
    // Only a working profile is worth answering with before discovery runs;
    // a transient failure must not greet the next launch as fact.
    if (profile.available && !failed)
      await providerProfileCache.put(key, profile).catch(() => {})
    const event: HarnessProfileEvent = { profile }
    if (reportedCwd !== undefined) event.cwd = reportedCwd
    for (const listener of listeners) listener(event)
    return profile
  })().finally(() => loading.delete(key))
  loading.set(key, request)
  // Callers that answer from a snapshot never observe this promise.
  request.catch(() => {})
  return request
}

/** Every provider, resolved. Hosts that filter on availability wait for discovery. */
export async function harnessProfiles(
  force = false,
  cwd?: string
): Promise<HarnessProfile[]> {
  return Promise.all(
    providerHost.profiles
      .list()
      .map((loader) => harnessProfile(loader.provider, force, cwd))
  )
}

/** Every provider, immediately: what is known now, with discovery reporting behind it. */
export async function harnessProfilesNow(
  cwd?: string
): Promise<HarnessProfile[]> {
  return providerHost.profiles.list().map((loader) => {
    void loadProfile(loader.provider, cwd, "now")
      .then((profile) => {
        if (!profile.pending)
          for (const listener of listeners) listener({ profile, cwd })
      })
      .catch(() => {})
    return pendingProviderProfile(loader)
  })
}

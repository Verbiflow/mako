import { accountEnv } from "./accounts.js"
import { realpath } from "node:fs/promises"
import { resolveHarnessTuning } from "./harness-models.js"
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
  openCodeInstallation,
  openCodeSessionGeneration,
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
const cache = new Map<string, { profile: HarnessProfile; loadedAt: number }>()
const loading = new Map<string, Promise<HarnessProfile>>()
const launching = new Map<string, Promise<HarnessProfile>>()
const listeners = new Set<(event: HarnessProfileEvent) => void>()
const DISPLAY_TTL_MS = 30_000

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
  if (!profile.available || profile.configurationError) {
    const reason = profile.error ?? profile.configurationError ?? `${profile.label} model discovery is unavailable. Refresh its settings before sending.`
    hostWarn("discovery", "send refused", { harness, model: tuning.model, error: reason })
    throw new Error(reason)
  }
  return resolveHarnessTuning(profile, tuning)
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
  const key = `${harness}:${accountKey}:${scope ?? ""}`
  const held = cache.get(key)
  if (mode !== "refresh" && held) {
    const fresh = Date.now() - held.loadedAt < DISPLAY_TTL_MS
    const trusted = held.profile.available && !held.profile.configurationError
    if (fresh || (mode === "send" && trusted)) return held.profile
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
  const request = loading.get(key) ?? startLoad(loader, key, env, scope, cwd)
  if (mode === "display" || mode === "now") {
    // Stale beats blank: the refresh lands as an event moments later.
    const snapshot = held?.profile ?? (await providerProfileCache.get(key))
    if (snapshot) return snapshot
    if (mode === "now") return pendingProviderProfile(loader)
  }
  return request
}

function startLoad(
  loader: ProviderProfileLoader,
  key: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  reportedCwd: string | undefined
): Promise<HarnessProfile> {
  const request = (async () => {
    let profile: HarnessProfile
    try {
      profile = await loader.load(env, cwd)
    } catch (error) {
      profile = unavailableProviderProfile(
        loader,
        error instanceof Error ? error.message : String(error)
      )
    }
    cache.set(key, { profile, loadedAt: Date.now() })
    // Only a working profile is worth answering with before discovery runs;
    // a transient failure must not greet the next launch as fact.
    if (profile.available)
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

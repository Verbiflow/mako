import { getMako, hasBridge } from "@/lib/bridge"
import type { HarnessProfile } from "@/lib/types"
import type { HarnessUpdateInfo } from "../../electron/contracts/harness-updates"
import { createHook, createStore } from "@/state/store"

export interface DaemonInfo {
  pid: number
  startedAt: number
  sessions: number
  rss?: number
  heapUsed?: number
  eventLoopP99Ms?: number
}

interface ProviderState {
  profiles: Record<string, HarnessProfile>
  contexts: Record<string, HarnessProfile>
  contextErrors: Record<string, string>
  availability: Record<string, boolean> | null
  /** Per-provider runtime update reads — binary, installed, latest, channel. */
  runtimeUpdates: Record<string, HarnessUpdateInfo> | null
  daemon: DaemonInfo | null
  daemonLogin: boolean | null
}

export const providerStore = createStore<ProviderState>({
  profiles: {},
  contexts: {},
  contextErrors: {},
  availability: null,
  runtimeUpdates: null,
  daemon: null,
  daemonLogin: null,
})

export const useProviders = createHook(providerStore)

let loaded = false
let loading: Promise<void> | null = null

export function providerProfileKey(provider: string, cwd: string): string {
  return JSON.stringify([provider, cwd])
}

const requests = new Map<string, Promise<void>>()
const loadedAt = new Map<string, number>()
const generations = new Map<string, number>()
const scopes = new Map<string, { provider: string; cwd: string }>()
const retries = new Map<string, { timer: ReturnType<typeof setTimeout>; delay: number }>()
/** Backoff for asking again after a failed discovery; tests shorten it. */
export const discoveryRetry = { firstMs: 10_000, maxMs: 120_000 }

/**
 * A failed discovery asks again on its own. The composer once waited for the
 * next window focus to recover from a timed-out `list_available_models`, and a
 * picker reading "Model unavailable" for that long looks like a broken account.
 */
function scheduleRetry(key: string, provider: string, cwd: string): void {
  const previous = retries.get(key)
  const delay = previous
    ? Math.min(previous.delay * 2, discoveryRetry.maxMs)
    : discoveryRetry.firstMs
  if (previous) clearTimeout(previous.timer)
  const timer = setTimeout(() => {
    if (retries.get(key)?.timer !== timer) return
    retries.set(key, { timer, delay })
    void providers.load(provider, true, cwd).catch(() => {})
  }, delay)
  retries.set(key, { timer, delay })
}

function clearRetry(key: string): void {
  const pending = retries.get(key)
  if (pending) clearTimeout(pending.timer)
  retries.delete(key)
}

/** One provider's discovery landed, from a request or a host event. */
export function admitProfile(profile: HarnessProfile, cwd: string): void {
  admit(profile, cwd)
  if (profile.available && !profile.configurationError && !profile.pending)
    clearRetry(providerProfileKey(profile.id, cwd))
}

function admit(profile: HarnessProfile, cwd: string): void {
  const key = providerProfileKey(profile.id, cwd)
  const previous = providerStore.get().contexts[key]
  // A borrowed catalog answers while discovery runs; it never replaces the
  // workspace's own report if that has already landed.
  if (profile.pending && previous && !previous.pending) return
  const failed = !profile.available || Boolean(profile.configurationError)
  const observed =
    previous?.available && failed
      ? {
          ...previous,
          configurationError: `${profile.configurationError ?? profile.error ?? "Settings refresh failed."} Showing the last reported settings.`,
        }
      : profile
  const contextErrors = { ...providerStore.get().contextErrors }
  delete contextErrors[key]
  providerStore.set({
    contextErrors,
    profiles: { ...providerStore.get().profiles, [profile.id]: observed },
    contexts: {
      ...providerStore.get().contexts,
      [key]: observed,
    },
  })
}

export const providers = {
  async refreshAccount(provider: string): Promise<void> {
    generations.set(provider, (generations.get(provider) ?? 0) + 1)
    const contexts = { ...providerStore.get().contexts }
    const contextErrors = { ...providerStore.get().contextErrors }
    const workspaces = new Set<string>()
    for (const [key, scope] of scopes) {
      if (scope.provider !== provider) continue
      workspaces.add(scope.cwd)
      delete contexts[key]
      delete contextErrors[key]
      loadedAt.delete(key)
      requests.delete(key)
      clearRetry(key)
    }
    const profiles = { ...providerStore.get().profiles }
    const previous = profiles[provider]
    if (previous) profiles[provider] = {
      id: previous.id, label: previous.label, transport: previous.transport,
      capabilities: previous.capabilities, models: [], available: false, pending: true,
    }
    providerStore.set({ profiles, contexts, contextErrors })
    if (!workspaces.size) workspaces.add("")
    await Promise.all(
      [...workspaces].map((cwd) => providers.load(provider, true, cwd))
    )
  },

  async loadAll(force = false): Promise<void> {
    if (!hasBridge() || (loaded && !force)) return
    if (loading) return loading
    const accountGenerations = new Map(generations)
    loading = getMako()
      .harnessProfiles(force)
      .then((profiles) => {
        const next = { ...providerStore.get().profiles }
        for (const profile of profiles) {
          if (
            (generations.get(profile.id) ?? 0) !==
            (accountGenerations.get(profile.id) ?? 0)
          )
            continue
          // A placeholder never replaces a discovery that already arrived.
          if (profile.pending && next[profile.id] && !next[profile.id].pending)
            continue
          next[profile.id] = profile
        }
        providerStore.set({ profiles: next })
        loaded = true
      })
      .catch(() => undefined)
      .finally(() => {
        loading = null
      })
    return loading
  },

  async load(provider: string, force = false, cwd = ""): Promise<void> {
    if (!hasBridge()) return
    const key = providerProfileKey(provider, cwd)
    scopes.set(key, { provider, cwd })
    const active = requests.get(key)
    if (active) return active
    if (!force && Date.now() - (loadedAt.get(key) ?? 0) < 30_000) return
    const generation = generations.get(provider) ?? 0
    const request = getMako()
      .harnessTuning(provider, cwd || undefined, force)
      .then((profile) => {
        if ((generations.get(provider) ?? 0) !== generation) return
        admit(profile, cwd)
        if (profile.pending) return
        if (profile.available && !profile.configurationError) {
          loadedAt.set(key, Date.now())
          clearRetry(key)
        } else scheduleRetry(key, provider, cwd)
      })
      .catch((error) => {
        if ((generations.get(provider) ?? 0) !== generation) return
        scheduleRetry(key, provider, cwd)
        providerStore.set({
          contextErrors: {
            ...providerStore.get().contextErrors,
            [key]:
              error instanceof Error
                ? error.message
                : "Model settings could not be loaded",
          },
        })
        throw error
      })
      .finally(() => {
        if (requests.get(key) === request) requests.delete(key)
      })
    requests.set(key, request)
    return request
  },

  async loadStatus(): Promise<void> {
    if (!hasBridge()) return
    const [availability, daemon, daemonLogin] = await Promise.all([
      getMako()
        .harnessAvailability()
        .catch(() => ({})),
      getMako()
        .daemonStatus()
        .catch(() => null),
      getMako()
        .daemonLogin()
        .catch(() => null),
    ])
    providerStore.set({ availability, daemon, daemonLogin })
  },

  async loadRuntimeUpdates(): Promise<void> {
    if (!hasBridge()) return
    providerStore.set({
      runtimeUpdates: await getMako()
        .harnessUpdates()
        .catch(() => null),
    })
  },

  /** Runs the provider's own updater, then re-reads what is installed. */
  async runRuntimeUpdate(provider: string): Promise<HarnessUpdateInfo> {
    const next = await getMako().runHarnessUpdate(provider)
    providerStore.set({
      runtimeUpdates: { ...providerStore.get().runtimeUpdates, [provider]: next },
    })
    return next
  },

  async setDaemonLogin(enabled: boolean): Promise<void> {
    const previous = providerStore.get().daemonLogin
    providerStore.set({ daemonLogin: enabled })
    try {
      await getMako().setDaemonLogin(enabled)
    } catch (error) {
      providerStore.set({ daemonLogin: previous })
      throw error
    }
  },
}

import { getMako, hasBridge } from "@/lib/bridge"
import type { HarnessProfile } from "@/lib/types"
import type {
  HarnessUpdateInfo,
  HarnessUpdates,
} from "@mako/host/contracts/harness-updates"
import { createHook, createStore } from "@/state/store"
import { pageRefetch } from "@/state/view-refetch"
import { DESK_SCOPE } from "@/state/desk-refetch"
import type { ViewRefetch } from "@/lib/view-refetch"

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
  /** The host's per-provider runtime readings — binary, installed, latest, channel, phase. */
  runtimeUpdates: HarnessUpdates | null
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

const requests = new Map<string, { settled: Promise<void>; forced: boolean }>()
/** The order each key's reads were sent in, and the latest one admitted: an older reply never lands over a newer. */
const sent = new Map<string, number>()
const admitted = new Map<string, number>()
const loadedAt = new Map<string, number>()
const generations = new Map<string, number>()
const scopes = new Map<string, { provider: string; cwd: string }>()
interface DiscoveryRetry {
  provider: string
  cwd: string
  delay: number
  due: number
  started: boolean
  timer?: ReturnType<typeof setTimeout>
}
const retries = new Map<string, DiscoveryRetry>()
let readers: ViewRefetch | undefined
/**
 * Backoff for asking again after a failed discovery; tests shorten it. It reaches the host's own longest hold: a
 * retry every two minutes at most kept a Claude discovery that timed out at 30 s running a quarter of the time.
 */
export const discoveryRetry = { firstMs: 10_000, maxMs: 600_000 }
/**
 * How long a profile the host answered is reused before a composer that mounts asks again. The ask is a read of what
 * the host holds, never a discovery by itself, and the host says what changed as `harness-profile` events.
 */
const PROFILE_REUSE_MS = 300_000

/**
 * Whether there is nothing of `profile` to show yet. A profile with models is shown whatever else it says: one held
 * from an earlier discovery lists the account's models while the harness is asked again.
 */
export function profileUnread(profile: HarnessProfile | undefined): boolean {
  return !profile || (profile.pending === true && profile.models.length === 0)
}

function providerReads(): ViewRefetch {
  if (readers) return readers
  const reads = readers = pageRefetch()
  reads.onState(() => {
    for (const [key, retry] of retries) {
      if (!reads.visible || !reads.connected(DESK_SCOPE)) {
        clearTimeout(retry.timer)
        retry.timer = undefined
      } else armRetry(key, retry)
    }
  })
  return reads
}

function armRetry(key: string, retry: DiscoveryRetry): void {
  const reads = providerReads()
  if (retry.started || retry.timer !== undefined || !reads.visible || !reads.connected(DESK_SCOPE)) return
  retry.timer = setTimeout(() => {
    retry.timer = undefined
    if (retries.get(key) !== retry || !reads.visible || !reads.connected(DESK_SCOPE)) return
    retry.started = true
    // A read, not an ask: the host retries the discovery on its own hold and this reads what came of it. Forced, each
    // retry started a CLI however recently the last one had failed.
    void providers.load(retry.provider, false, retry.cwd).catch(() => {})
  }, Math.max(0, retry.due - Date.now()))
}

/**
 * A failed discovery asks again while the page can show it. The composer once waited for the
 * next window focus to recover from a timed-out `list_available_models`, and a
 * picker reading "Model unavailable" for that long looks like a broken account.
 */
function scheduleRetry(key: string, provider: string, cwd: string): void {
  const previous = retries.get(key)
  const delay = previous
    ? Math.min(previous.delay * 2, discoveryRetry.maxMs)
    : discoveryRetry.firstMs
  if (previous) clearTimeout(previous.timer)
  const retry = { provider, cwd, delay, due: Date.now() + delay, started: false }
  retries.set(key, retry)
  armRetry(key, retry)
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

/** The host's runtime readings landed, from a request or a `runtime-updates` event. */
export function admitRuntimeUpdates(updates: HarnessUpdates): void {
  providerStore.set({ runtimeUpdates: updates })
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
      models: [], available: false, pending: true,
    }
    providerStore.set({ profiles, contexts, contextErrors })
    if (!workspaces.size) workspaces.add("")
    await Promise.all(
      [...workspaces].map((cwd) => providers.load(provider, true, cwd))
    )
  },

  /**
   * Every harness as the host holds it. A window's start reads snapshots and starts no discovery; `force` is the
   * person asking Settings to read every harness again.
   */
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

  /**
   * The picker opened in `cwd`: every harness it lists is asked for its models now. This is the one place a person
   * asks, so a model a harness released since its last discovery appears here.
   */
  async askShown(cwd: string): Promise<void> {
    await providers.loadAll()
    await Promise.all(Object.keys(providerStore.get().profiles).map((provider) => providers.load(provider, true, cwd).catch(() => {})))
  },

  /**
   * Every harness, for a page that lists each one's models: what is held, then a read of each harness nothing is
   * held for, which is the only case the host discovers for a read.
   */
  async loadListed(): Promise<void> {
    await providers.loadAll()
    await Promise.all(Object.values(providerStore.get().profiles)
      .filter((profile) => profileUnread(profile))
      .map((profile) => providers.load(profile.id, false, "").catch(() => {})))
  },

  /**
   * One harness in `cwd`. Unforced, it reads what the host holds (the host refreshes behind its answer when that is
   * due); `force` asks the harness itself.
   */
  async load(provider: string, force = false, cwd = ""): Promise<void> {
    if (!hasBridge()) return
    const key = providerProfileKey(provider, cwd)
    scopes.set(key, { provider, cwd })
    const active = requests.get(key)
    // A read in flight answers another read. It does not answer an ask: the picker's rows read as they mount, and
    // the ask made by opening it must still reach the harness.
    if (active && (active.forced || !force)) return active.settled
    const reusedFrom = loadedAt.get(key)
    if (!force && reusedFrom !== undefined && Date.now() - reusedFrom < PROFILE_REUSE_MS) return
    const generation = generations.get(provider) ?? 0
    const turn = (sent.get(key) ?? 0) + 1
    sent.set(key, turn)
    const request = getMako()
      .harnessTuning(provider, cwd || undefined, force)
      .then((profile) => {
        if ((generations.get(provider) ?? 0) !== generation) return
        if (turn < (admitted.get(key) ?? 0)) return
        admitted.set(key, turn)
        admit(profile, cwd)
        if (profile.pending) return
        if (profile.available && !profile.configurationError) {
          loadedAt.set(key, Date.now())
          clearRetry(key)
        } else {
          // What was reused is no longer what the host holds: the retry's read must reach it.
          loadedAt.delete(key)
          scheduleRetry(key, provider, cwd)
        }
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
        if (requests.get(key)?.settled === request) requests.delete(key)
      })
    requests.set(key, { settled: request, forced: force })
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

  /**
   * The host's runtime readings as they stand. The host reads on its own
   * clock and pushes every change as `runtime-updates`; this answers at once
   * from what it holds, and `refresh` asks it to read everything again.
   */
  async loadRuntimeUpdates(refresh = false): Promise<void> {
    if (!hasBridge()) return
    const updates = await getMako()
      .harnessUpdates(refresh)
      .catch(() => null)
    if (updates) admitRuntimeUpdates(updates)
  },

  /** Runs the runtime's update on the host, which reports progress as events and settles with the receipt. */
  async runRuntimeUpdate(provider: string): Promise<HarnessUpdateInfo> {
    const next = await getMako().runHarnessUpdate(provider)
    admitRuntimeUpdates({ ...providerStore.get().runtimeUpdates, [provider]: next })
    return next
  },

  /**
   * Installs a missing runtime on the host, then re-reads which agents can run so the row turns ready. Every place
   * that offers the install shows it working from the click, before the host's own reading says so, and a refusal
   * lands as the reading's failure, so each of them says it the same way.
   */
  async runRuntimeInstall(provider: string): Promise<HarnessUpdateInfo> {
    const working: HarnessUpdateInfo = { ...providerStore.get().runtimeUpdates?.[provider], phase: "installing" }
    delete working.result
    admitRuntimeUpdates({ ...providerStore.get().runtimeUpdates, [provider]: working })
    let next: HarnessUpdateInfo
    try {
      next = await getMako().runHarnessInstall(provider)
    } catch (error) {
      next = { ...providerStore.get().runtimeUpdates?.[provider] ?? working }
      delete next.phase
      next.result = { at: Date.now(), outcome: "failed", message: error instanceof Error ? error.message : String(error) }
    }
    admitRuntimeUpdates({ ...providerStore.get().runtimeUpdates, [provider]: next })
    if (next.result?.outcome === "installed")
      await providers.loadAll(true).then(() => providers.loadStatus())
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

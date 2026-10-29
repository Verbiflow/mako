import { AsyncLocalStorage } from "node:async_hooks"
import { registerHooks } from "node:module"
import type { HostDomain } from "../contracts/runtime.js"
import type { HostWork } from "./event-loop.js"
import { hostLog, hostWarn } from "./host-log.js"

/** When a domain loads: in the background once the socket answers, or at the first call that needs it. */
export type DomainLoad = HostDomain["load"]

export interface DomainManifest<Service> {
  load: DomainLoad
  /** The domains of packages/host/src it builds, whose methods are its own. */
  covers: readonly string[]
  /** Domains it's built on; each loads first. */
  needs?: readonly string[]
  /** Builds the domain, importing its implementation then; `reason` is why it's loading. */
  open(reason: string): Promise<Service>
}

export interface Domain<Service> {
  readonly name: string
  /** The domain, loading it first for `reason` if it isn't yet; a failed load stays failed. */
  load(reason: string): Promise<Service>
  /** The domain once ready, for a caller that must not cause the load. */
  current(): Service | undefined
  /** Its load once begun, whatever its state, without beginning it. */
  started(): Promise<Service> | undefined
}

interface Entry {
  record: HostDomain
  /** Loads it once for the first reason given; later calls share that load. */
  load(reason: string): Promise<void>
}

export interface HostDomainsOptions {
  /** `MAKO_HOST_LOAD=all`: every domain loads after the socket listens, to rule laziness out. */
  loadAll: boolean
  /** `MAKO_TRACE_MODULES=1`: every module load is logged with its time and the domain that caused it. */
  traceModules: boolean
}

/**
 * The host's domains and how each loads. One promise per domain, so
 * concurrent first calls share a single load; a domain's needs load first.
 * Each records why it loaded, when, how long it took and the modules it
 * brought in, which `/health` and `mako-host inspect` show.
 */
export class HostDomains {
  private readonly entries = new Map<string, Entry>()
  private readonly loading = new AsyncLocalStorage<string>()
  private readonly options: HostDomainsOptions
  private readonly work: HostWork
  private accounting = false

  constructor(options: HostDomainsOptions, work: HostWork) {
    this.options = options
    this.work = work
  }

  declare<Service>(name: string, manifest: DomainManifest<Service>): Domain<Service> {
    if (this.entries.has(name)) throw new Error(`The ${name} domain is declared twice`)
    for (const need of manifest.needs ?? [])
      if (!this.entries.has(need)) throw new Error(`The ${name} domain needs ${need}, which isn't declared before it`)
    const owner = [...this.entries].find(([, entry]) => entry.record.covers.some((covered) => manifest.covers.includes(covered)))
    if (owner) throw new Error(`The ${name} and ${owner[0]} domains both cover ${manifest.covers.filter((covered) => owner[1].record.covers.includes(covered)).join(", ")}`)
    const record: HostDomain = { name, covers: [...manifest.covers], load: manifest.load, state: "unloaded" }
    let loaded: Promise<Service> | undefined
    let service: Service | undefined
    const load = (reason: string): Promise<Service> =>
      (loaded ??= this.open(record, manifest, reason).then((opened) => (service = opened)))
    this.entries.set(name, { record, load: async (reason) => void (await load(reason)) })
    return { name, load, current: () => service, started: () => loaded }
  }

  /** The domain covering a folder of packages/host/src, which declares that folder's methods. */
  covering(folder: string): string | undefined {
    for (const [name, entry] of this.entries) if (entry.record.covers.includes(folder)) return name
    return undefined
  }

  load(name: string, reason: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) return Promise.reject(new Error(`No ${name} domain is declared`))
    return entry.load(reason)
  }

  /**
   * After the socket listens: each `after-listen` domain, or every domain
   * with `MAKO_HOST_LOAD=all`, one at a time, yielding to calls between them.
   */
  async afterListen(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.record.load !== "after-listen" && !this.options.loadAll) continue
      await new Promise<void>((resolve) => setImmediate(resolve))
      await entry.load(entry.record.load === "on-demand" ? "MAKO_HOST_LOAD=all" : "after-listen")
    }
  }

  snapshot(): HostDomain[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.record, covers: [...entry.record.covers] }))
  }

  /**
   * Counts the modules that first load while each domain loads, and their
   * source bytes. Called once the host starts, never at import.
   */
  accountModules(): void {
    if (this.accounting) return
    this.accounting = true
    const started = performance.now()
    registerHooks({
      load: (url, context, next) => {
        const result = next(url, context)
        const name = this.loading.getStore()
        const record = name ? this.entries.get(name)?.record : undefined
        if (record) {
          record.modules = (record.modules ?? 0) + 1
          record.sourceBytes = (record.sourceBytes ?? 0) + sourceBytes(result.source)
        }
        if (this.options.traceModules)
          hostLog("modules", "loaded", { url, domain: name ?? "start", at: Math.round(performance.now() - started) })
        return result
      },
    })
  }

  private async open<Service>(record: HostDomain, manifest: DomainManifest<Service>, reason: string): Promise<Service> {
    const { name } = record
    for (const need of manifest.needs ?? []) await this.load(need, `${name} needs it`)
    const began = performance.now()
    Object.assign(record, { state: "loading", reason, startedAt: Math.round(began), modules: 0, sourceBytes: 0 })
    try {
      const service = await this.work.run(`load the ${name} domain`, () => this.loading.run(name, () => manifest.open(reason)))
      Object.assign(record, { state: "ready", loadMs: Math.round(performance.now() - began) })
      hostLog("domains", `${name} loaded`, { for: reason, ms: record.loadMs, modules: record.modules ?? 0 })
      return service
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      Object.assign(record, { state: "failed", error: message, loadMs: Math.round(performance.now() - began) })
      hostWarn("domains", `${name} failed to load`, { for: reason, error: message })
      throw error
    }
  }
}

/** The options a host process's environment sets. */
export function hostDomainOptions(env: NodeJS.ProcessEnv = process.env): HostDomainsOptions {
  return { loadAll: env.MAKO_HOST_LOAD === "all", traceModules: env.MAKO_TRACE_MODULES === "1" }
}

function sourceBytes(source: string | ArrayBuffer | NodeJS.TypedArray | undefined | null): number {
  if (source === undefined || source === null) return 0
  return source instanceof ArrayBuffer || ArrayBuffer.isView(source) ? source.byteLength : Buffer.byteLength(source)
}

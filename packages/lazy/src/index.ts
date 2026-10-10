/**
 * A package Mako loads the first time something needs it, rather than when a
 * process starts, and the one record of what each process has loaded, when,
 * for whom and at what cost.
 */
export interface LazyPackage<Module> {
  /** The npm package, or `package (adapter)` for a Mako module built on one. */
  readonly name: string
  /**
   * The package, loaded at the first call. `reason` names what needed it; the
   * first one is kept, so the record says why the package is in the process.
   */
  load(reason: string): Promise<Module>
}

export type PackageLoad =
  | { name: string; state: "unloaded" }
  | { name: string; state: "loading"; reason: string; startedAt: number }
  | { name: string; state: "ready"; reason: string; startedAt: number; ms: number }
  | { name: string; state: "failed"; reason: string; startedAt: number; ms: number; error: string }

type Listener = (load: PackageLoad) => void

interface PackageRecord {
  loads: Map<string, PackageLoad>
  listeners: Set<Listener>
}

declare global {
  /** The process's record, shared by every copy of this module a process ends up with. */
  var makoLazyPackages: PackageRecord | undefined
}

/**
 * The record is the process's, as Node's module cache is. A process can hold a
 * declaration twice, when a tool or test reaches the same package by its source
 * and by its build, and can hold two copies of this module; both still record
 * into one place, by package name.
 */
const record = (globalThis.makoLazyPackages ??= { loads: new Map(), listeners: new Set() })

function update(load: PackageLoad): void {
  record.loads.set(load.name, load)
  for (const listener of record.listeners) listener(load)
}

/**
 * Declares a package to load on first use. A failed load stays failed: an
 * import that couldn't resolve or evaluate won't succeed on a second try, and
 * every caller gets the same error rather than a retry behind its back.
 */
export function lazyPackage<Module>(name: string, load: () => Promise<Module>): LazyPackage<Module> {
  if (!record.loads.has(name)) record.loads.set(name, { name, state: "unloaded" })
  let loading: Promise<Module> | undefined
  return {
    name,
    load(reason) {
      if (loading) return loading
      // Another declaration of this package has loaded it, so Node's module cache answers; there's nothing new to record.
      if (record.loads.get(name)?.state === "ready") return (loading = load())
      const startedAt = Date.now()
      const started = performance.now()
      update({ name, state: "loading", reason, startedAt })
      loading = load().then(
        (module) => {
          update({ name, state: "ready", reason, startedAt, ms: Math.round(performance.now() - started) })
          return module
        },
        (error) => {
          const message = error instanceof Error ? error.message : String(error)
          update({ name, state: "failed", reason, startedAt, ms: Math.round(performance.now() - started), error: message })
          throw new Error(`${name} could not be loaded for ${reason}: ${message}`, { cause: error })
        }
      )
      return loading
    },
  }
}

/** Every lazy package this process has declared, loaded or not, in declaration order. */
export function packageLoads(): PackageLoad[] {
  return [...record.loads.values()]
}

/** Called with every change of state, for the process's log. */
export function onPackageLoad(listener: Listener): () => void {
  record.listeners.add(listener)
  return () => record.listeners.delete(listener)
}

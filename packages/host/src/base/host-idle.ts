import { mkdir, readdir, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * A profile host that nobody is using should not run forever.
 *
 * The installed app's host is the product: it stays up so agents outlive
 * every window. A profile host is different. It exists for one checkout, one
 * test run or one review, and the launcher that started it is usually the
 * only thing that knows it is there. Three of them were found idling for two
 * days, each rescanning the session catalog and rewriting its cache every
 * minute for no reader.
 *
 * Idle means: no client attached, no launcher lease, no lifecycle work, no
 * shutdown already in progress. Only a continuous idle span longer than the
 * window counts; any activity restarts it. The decision to stop is taken once.
 *
 * The window only has to bridge a launcher's restart, from its old lease to its
 * new one. A profile host does not stay up waiting for a launcher to return:
 * starting it again takes a few seconds, and one left running costs a whole
 * Electron process and its helpers.
 */
export const PROFILE_HOST_IDLE_MS = 15_000

export interface IdleShutdownDependencies {
  idleMs: number
  busy(): boolean
  quit(): void
  now(): number
}

export class IdleShutdown {
  private idleSince: number | null = null
  private stopped = false
  private readonly dependencies: IdleShutdownDependencies
  constructor(dependencies: IdleShutdownDependencies) {
    this.dependencies = dependencies
  }

  /** How long the host has been continuously idle, in milliseconds. */
  get idleFor(): number {
    return this.idleSince === null ? 0 : this.dependencies.now() - this.idleSince
  }

  /** Observe the host once; returns true when this call requested the quit. */
  tick(): boolean {
    if (this.stopped) return false
    if (this.dependencies.busy()) {
      this.idleSince = null
      return false
    }
    const now = this.dependencies.now()
    this.idleSince ??= now
    if (now - this.idleSince < this.dependencies.idleMs) return false
    this.stopped = true
    this.dependencies.quit()
    return true
  }
}

const LEASE_PREFIX = "lease-"

function leaseDirectory(hostDirectory: string): string {
  return join(hostDirectory, "leases")
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A launcher's claim on a profile host, keyed by its own pid so a crashed
 * launcher's lease expires with its process and never holds a host open.
 * Lives beside the host socket, in the user-private runtime directory.
 */
export async function holdHostLease(hostDirectory: string, pid = process.pid): Promise<() => Promise<void>> {
  const directory = leaseDirectory(hostDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, `${LEASE_PREFIX}${pid}`)
  await writeFile(file, String(pid), { mode: 0o600 })
  return async () => {
    await unlink(file).catch(() => undefined)
  }
}

/** Pids of launchers currently holding this host; dead holders are removed. */
export async function activeHostLeases(hostDirectory: string): Promise<number[]> {
  const directory = leaseDirectory(hostDirectory)
  const names = await readdir(directory).catch((): string[] => [])
  const holders: number[] = []
  for (const name of names) {
    if (!name.startsWith(LEASE_PREFIX)) continue
    const pid = Number(name.slice(LEASE_PREFIX.length))
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (processAlive(pid)) holders.push(pid)
    else await unlink(join(directory, name)).catch(() => undefined)
  }
  return holders
}

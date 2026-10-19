/**
 * Which running work uses each account Mako keeps, so removing one never
 * deletes credentials a live process still reads.
 *
 * A hold is taken under the provider's account lease, together with the
 * launch it covers, and released once that process is gone. Within a host
 * the registry is exact. Hosts sharing ~/.mako (the installed app and a
 * development copy) each leave one lease file naming the accounts they hold;
 * a lease whose host exited, or whose pid now belongs to another program,
 * holds nothing and is cleared by the next reader.
 *
 * Removal writes its marker before reading holds, and a release clears its
 * lease before looking for a marker, so one of the two always sees the
 * other: an account is never removed under a holder, and never left pending
 * after its last holder ends.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { accountsRoot } from "./accounts-common.js"
import { hostWarn } from "../base/host-log.js"
import { processIdentityMatches } from "../base/process-liveness.js"

/** What holds an account: a live session's binding, a headless run, or a short utility call. */
export type AccountHolder =
  | { kind: "session"; binding: string }
  | { kind: "run" }
  | { kind: "utility" }

export interface AccountHold {
  readonly provider: string
  readonly name: string
  /** Idempotent. */
  release(): void
}

interface Entry {
  holder: AccountHolder
}

const HOST_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000)
const LIVENESS_TIMEOUT_MS = 2_000

/**
 * A host's lease. A newer Mako's lease is read for what this build knows of
 * it: a live host whose accounts this build can't read counts as holding
 * the account, so removal waits rather than guessing.
 */
const Lease = z.object({
  version: z.number().int(),
  pid: z.number().int().positive(),
  startedAt: z.number(),
  accounts: z.array(z.string()).optional(),
})

function accountKey(provider: string, name: string): string {
  return `${provider}/${name}`
}

function holdsDir(): string {
  return join(accountsRoot(), "holds")
}

function leasePath(pid: number): string {
  return join(holdsDir(), `${pid}.json`)
}

/** The accounts this host's running work holds, and the lease that tells other hosts. */
export class AccountHolds {
  private readonly held = new Map<string, { provider: string; name: string; entries: Set<Entry> }>()
  private readonly releasedListeners = new Set<(provider: string, name: string) => void>()

  hold(provider: string, name: string, holder: AccountHolder): AccountHold {
    const key = accountKey(provider, name)
    let account = this.held.get(key)
    const first = !account
    if (!account) {
      account = { provider, name, entries: new Set() }
      this.held.set(key, account)
    }
    const entry: Entry = { holder }
    account.entries.add(entry)
    if (first) this.writeLease()
    let released = false
    return {
      provider,
      name,
      release: () => {
        if (released) return
        released = true
        const current = this.held.get(key)
        if (!current?.entries.delete(entry) || current.entries.size) return
        this.held.delete(key)
        this.writeLease()
        for (const listener of this.releasedListeners) listener(provider, name)
      },
    }
  }

  /** This host's holders of one account. */
  holders(provider: string, name: string): AccountHolder[] {
    return [...(this.held.get(accountKey(provider, name))?.entries ?? [])].map((entry) => entry.holder)
  }

  /** Which held account a live binding runs on, if any. */
  binding(binding: string): { provider: string; name: string } | undefined {
    for (const account of this.held.values())
      for (const entry of account.entries)
        if (entry.holder.kind === "session" && entry.holder.binding === binding)
          return { provider: account.provider, name: account.name }
    return undefined
  }

  /** Called after an account's last holder on this host lets go. */
  onReleased(listener: (provider: string, name: string) => void): () => void {
    this.releasedListeners.add(listener)
    return () => this.releasedListeners.delete(listener)
  }

  /**
   * Whether another live host holds the account. A host that cannot be checked
   * counts as holding it: removal waits rather than guessing.
   */
  async heldElsewhere(provider: string, name: string): Promise<boolean> {
    const key = accountKey(provider, name)
    const files = await readdir(holdsDir()).catch(() => [])
    for (const file of files) {
      if (!file.endsWith(".json") || file === `${process.pid}.json`) continue
      const path = join(holdsDir(), file)
      let lease: z.infer<typeof Lease>
      try {
        lease = Lease.parse(JSON.parse(await readFile(path, "utf8")))
      } catch {
        continue
      }
      let alive: boolean
      try {
        alive = await processIdentityMatches({ pid: lease.pid, startedAt: lease.startedAt, signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS) })
      } catch {
        alive = true
      }
      if (!alive) {
        await rm(path, { force: true })
        continue
      }
      if (!lease.accounts || lease.accounts.includes(key)) return true
    }
    return false
  }

  /** Rewritten only when an account gains its first holder or loses its last. */
  private writeLease(): void {
    const path = leasePath(process.pid)
    try {
      if (!this.held.size) {
        rmSync(path, { force: true })
        return
      }
      mkdirSync(holdsDir(), { recursive: true, mode: 0o700 })
      const temporary = `${path}.tmp`
      writeFileSync(temporary, JSON.stringify({
        version: 1,
        pid: process.pid,
        startedAt: HOST_STARTED_AT,
        accounts: [...this.held.keys()],
      }), { mode: 0o600 })
      renameSync(temporary, path)
    } catch (error) {
      hostWarn("accounts", "account lease could not be written", { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

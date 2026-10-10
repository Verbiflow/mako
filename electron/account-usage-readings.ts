import type { AccountProvider, AccountUsage, HarnessAccount, ResetCreditOutcome } from "@mako/host/contracts/accounts"
import { hasReset, nextReset } from "@mako/host/contracts/account-usage"
import type { ProviderAccountCapability } from "./providers/account-capability.js"
import type { ProviderRegistry } from "./providers/registry.js"

/** A reading's amendment from limits a live session reported; `undefined` asks for a fresh read. */
export type UsageAmendment = (previous: AccountUsage | undefined) => AccountUsage | undefined

interface CachedUsage {
  usage: AccountUsage
  expiresAt: number
}

const USAGE_FRESH_MS = 60_000
const USAGE_RETRY_MS = 15_000
/** How old a kept reading may be before a failed refresh stops covering for it. */
const LAST_GOOD_MS = 30 * 60_000
const SPENT_THROTTLE_MS = 20_000

/**
 * One reading per account, read on demand and kept until it stops being true.
 *
 * Nothing polls. A reading is read again when it is asked for after it
 * expired: a minute after a good read (sooner on a failed one), at once when
 * one of its windows resets, and whenever the account was spent — a turn
 * ended in Mako, the harness wrote to its session store from anywhere, or a
 * live session reported its limits (which needs no request at all). A login
 * that changes identity under the same name starts over. Readers asking at
 * once share one request, and a failed refresh keeps the last good reading
 * with its age rather than blanking it.
 */
export class AccountUsageReadings {
  private readonly cache = new Map<string, CachedUsage>()
  /** The latest good reading per account, kept through failed refreshes. */
  private readonly lastGood = new Map<string, Extract<AccountUsage, { status: "ok" }>>()
  private readonly reads = new Map<string, Promise<AccountUsage>>()
  /** Effective credential equality remains host-only, independent of display name/email. */
  private readonly revisions = new Map<string, string>()
  /** Who each `harness:name` was signed in as when the accounts were last listed. */
  private readonly identities = new Map<string, string>()
  private readonly listeners = new Set<(harness: string, name: string, usage: AccountUsage) => void>()
  private readonly spentAt = new Map<string, number>()

  private readonly capabilities: ProviderRegistry<ProviderAccountCapability>

  constructor(capabilities: ProviderRegistry<ProviderAccountCapability>) {
    this.capabilities = capabilities
  }

  /** Readings that change outside a request: a live session's limits. */
  onChange(listener: (harness: string, name: string, usage: AccountUsage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async read(provider: AccountProvider, name: string): Promise<AccountUsage> {
    const key = `${provider}:${name}`
    const capability = this.capabilities.get(provider)
    let revision: string | undefined
    try { revision = await capability?.credentialRevision(name) }
    catch { return { status: "error", detail: "The account credentials could not be read." } }
    if (revision !== undefined && this.revisions.get(key) !== revision) {
      this.forgetKey(key)
      this.revisions.set(key, revision)
    }
    const cached = this.cache.get(key)
    if (cached && Date.now() < cached.expiresAt) return cached.usage
    const reading = this.reads.get(key)
    if (reading) return reading
    const read: Promise<AccountUsage> = this.readNative(capability, provider, name)
      .then(async (result) => {
        // A native refresh can rotate credentials while reading. Never cache a
        // result or carry last-good usage across that unacknowledged boundary.
        const after = await capability?.credentialRevision(name).catch(() => undefined)
        if (after !== revision) {
          if (this.reads.get(key) === read) this.forgetKey(key)
          return result
        }
        return this.settle(key, read, result)
      })
      .finally(() => {
        if (this.reads.get(key) === read) this.reads.delete(key)
      })
    this.reads.set(key, read)
    return read
  }

  /**
   * A live session reported its account's limits. Amends the cached reading
   * and tells listeners, so the meter moves without a request. With no whole
   * reading to amend, the account is read again instead.
   */
  observe(harness: string, name: string, amend: UsageAmendment): void {
    const key = `${harness}:${name}`
    const now = Date.now()
    const usage = amend(this.cache.get(key)?.usage ?? this.lastGood.get(key))
    if (!usage) {
      void this.read(harness, name).then((read) => {
        for (const listener of this.listeners) listener(harness, name, read)
      })
      return
    }
    this.reads.delete(key)
    this.store(key, usage, now)
    for (const listener of this.listeners) listener(harness, name, usage)
  }

  /**
   * Spend one reset credit. Whatever the answer, or none, the reading taken
   * before is no longer trusted: a lost reply may still have spent it.
   */
  async useResetCredit(harness: AccountProvider, name: string, attempt: string): Promise<ResetCreditOutcome> {
    const capability = this.capabilities.get(harness)
    if (!capability?.useResetCredit)
      throw new Error(`${capability?.label ?? harness} has no reset credits to use`)
    try {
      return await capability.useResetCredit(name, attempt)
    } finally {
      this.forget(harness, name)
    }
  }

  /**
   * The harness was just used — a turn ended in Mako, or its session store
   * changed from anywhere — so its readings are old. Drops them and says
   * whether windows should read again: at most once per `throttleMs` per
   * harness, so a busy session does not become a stream of requests.
   */
  spent(harness: string, throttleMs = SPENT_THROTTLE_MS): boolean {
    if (!this.capabilities.get(harness)) return false
    const last = this.spentAt.get(harness) ?? 0
    if (Date.now() - last < throttleMs) return false
    this.spentAt.set(harness, Date.now())
    for (const key of this.cache.keys())
      if (key.startsWith(`${harness}:`)) this.cache.delete(key)
    return true
  }

  /** The account's credentials changed: what was read for them no longer applies. */
  forget(harness: string, name: string): void {
    this.forgetKey(`${harness}:${name}`)
  }

  /** A different login under the same account name: its old reading belongs to someone else. */
  noteIdentities(accounts: readonly HarnessAccount[]): void {
    for (const account of accounts) {
      const key = `${account.harness}:${account.name}`
      const identity = account.email ?? account.plan ?? ""
      const known = this.identities.get(key)
      if (known !== undefined && known !== identity) this.forgetKey(key)
      this.identities.set(key, identity)
    }
  }

  private store(key: string, usage: AccountUsage, now: number, retry = usage.status !== "ok"): void {
    const expiresAt = Math.min(now + (retry ? USAGE_RETRY_MS : USAGE_FRESH_MS), nextReset(usage, now) ?? Infinity)
    this.cache.set(key, { usage, expiresAt })
    if (usage.status === "ok" && !retry) this.lastGood.set(key, usage)
  }

  /**
   * A read that a newer one, a live reading or a new login superseded while it
   * was in flight answers its caller but leaves the cache alone.
   */
  private settle(key: string, read: Promise<AccountUsage>, result: AccountUsage): AccountUsage {
    const at = Date.now()
    const usage: AccountUsage = result.status === "ok" ? { ...result, readAt: at } : result
    const good = this.lastGood.get(key)
    const kept =
      this.reads.get(key) === read &&
      usage.status === "error" &&
      good !== undefined &&
      !hasReset(good, at) &&
      at - (good.readAt ?? 0) < LAST_GOOD_MS
        ? good
        : undefined
    if (this.reads.get(key) === read) this.store(key, kept ?? usage, at, kept !== undefined || usage.status !== "ok")
    return kept ?? usage
  }

  private readNative(capability: ProviderAccountCapability | undefined, provider: string, name: string): Promise<AccountUsage> {
    if (!capability) return Promise.resolve({ status: "unavailable", detail: `Native usage is unavailable for ${provider}` })
    return capability.accountUsage(name).catch((error) => ({
      status: "error" as const,
      detail: error instanceof Error ? error.message : String(error),
    }))
  }

  private forgetKey(key: string): void {
    this.cache.delete(key)
    this.reads.delete(key)
    this.lastGood.delete(key)
  }
}

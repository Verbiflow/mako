/**
 * Several accounts per harness, one machine.
 *
 * The mechanism is borrowed from Orca, which does this right: an account is
 * an *isolated config home* — a directory holding nothing but credentials —
 * selected by environment variable at spawn time (`CLAUDE_CONFIG_DIR` for
 * Claude Code, `CODEX_HOME` for Codex). No harness ever knows more than one
 * account exists; it just wakes up in a home that happens to hold different
 * keys.
 *
 * Two decisions keep this sane:
 *
 *   * **Everything except credentials is a symlink back to the real home.**
 *     Skills, agents, commands, prompts, config — and above all the session
 *     stores — are shared. Switch accounts and every skill is still there,
 *     every session is still in the rail, and new sessions land in the same
 *     watched store. The *only* thing an account isolates is who pays.
 *   * **Credentials are captured, never invented.** "Add account" copies the
 *     login the CLI already has — sign into the other account with the CLI
 *     as usual, capture it here, switch back. On macOS, Claude Code 2.1+
 *     scopes its Keychain entry by `sha256(configDir)[:8]`, so capture also
 *     writes the scoped Keychain entry the spawned CLI will actually read.
 *
 * Usage comes from the providers' own endpoints: Claude's OAuth usage API,
 * ChatGPT's backend usage API for Codex and OpenCode, Cursor's dashboard
 * service, Grok's ACP billing method and Devin's seat status. Each reports
 * whatever windows its plan has — five hours, a day, a week, a month — so
 * usage is a list, never a fixed pair. A stale token is a classified state,
 * not an error toast — providers refresh their own token the next time they
 * run, and the number appears.
 *
 * Provider-specific parsing, capture, environment, and usage live in the
 * independent account capability registry. This file intentionally remains
 * the stable compatibility facade used by IPC and process launchers.
 */

import type {
  AccountCatalog,
  AccountHarness,
  AccountProvider,
  AccountUsage,
  HarnessAccount,
  ResetCreditOutcome,
  SelectedAccount,
} from "./account-types.js"
import {
  childProcessEnv,
  readSelection,
  writeSelection,
} from "./accounts-common.js"
import type {
  ProviderAccountCapability,
  SelectableAccountCapability,
} from "./providers/account-capability.js"
import { providerHost } from "./providers/index.js"
import { bindingWindow, hasReset, nextReset, windowsAt } from "./contracts/account-usage.js"

export type {
  AccountCatalog,
  AccountProviderInfo,
  AccountHarness,
  AccountProvider,
  AccountUsage,
  HarnessAccount,
  OpenCodeAuthType,
  ResetCreditOutcome,
  SelectedAccount,
  UsageBalance,
  UsageResetCredits,
  UsageWindow,
} from "./account-types.js"
function selectableCapability(provider: string): SelectableAccountCapability {
  const capability = providerHost.accountCapabilities.get(provider)
  if (!capability || capability.mode !== "selectable") {
    throw new Error(`Provider ${provider} does not support account selection`)
  }
  return capability
}

async function capabilitySelection(
  capability: ProviderAccountCapability
): Promise<string | null> {
  return capability.mode === "selectable"
    ? readSelection(capability.provider)
    : null
}

/* ------------------------------------------------------------ listing */

export async function listAccounts(): Promise<HarnessAccount[]> {
  const lists = await Promise.all(
    providerHost.accountCapabilities.list().map(listCapabilityAccounts)
  )
  const accounts = lists.flat()
  noteIdentities(accounts)
  return accounts
}

async function listCapabilityAccounts(
  capability: ProviderAccountCapability
): Promise<HarnessAccount[]> {
  // One provider's slow or broken login must not hide every other account.
  return capability
    .listAccounts(await capabilitySelection(capability))
    .catch(() => [])
}

async function harnessAccounts(
  harness: AccountHarness
): Promise<HarnessAccount[]> {
  const capability = providerHost.accountCapabilities.get(harness)
  return capability ? listCapabilityAccounts(capability) : []
}

export async function accountCatalog(): Promise<AccountCatalog> {
  return {
    providers: providerHost.accountCapabilities
      .list()
      .map(({ provider, label, mode, loginCommand }) => ({
        provider,
        label,
        mode,
        loginCommand,
      })),
    accounts: await listAccounts(),
  }
}

/* ------------------------------------------------------------ capture */

/**
 * Capture the harness's *current* login as a named account.
 *
 * Sign into the other account with the CLI the ordinary way, capture, and
 * switch back — browser OAuth is a dance only the CLI itself can drive.
 */
export async function captureAccount(
  harness: AccountHarness,
  name: string
): Promise<void> {
  await selectableCapability(harness).captureAccount(name)
}

export async function removeAccount(
  harness: AccountHarness,
  name: string
): Promise<void> {
  const capability = selectableCapability(harness)
  if ((await readSelection(harness)) === name)
    await selectAccount(harness, null)
  await capability.removeAccount(name)
}

/* ------------------------------------------------------------ selection */

/** `null` selects the CLI's own login (the real home, untouched). */
export async function selectAccount(
  harness: AccountHarness,
  name: string | null
): Promise<void> {
  const capability = selectableCapability(harness)
  if (name !== null)
    await capability.accountEnv(name, childProcessEnv(process.env))
  await writeSelection(harness, name)
}

/**
 * The environment for spawning a provider CLI under the selected account.
 *
 * Applied by every spawn path — headless drivers, fresh continuations, ACP —
 * so "switch account" means every future run, not some of them. Providers
 * strip auth env vars that could override the chosen isolated credentials.
 * Providers without account support keep the default account and environment.
 */
export async function accountEnv(
  provider: string,
  base: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const env = childProcessEnv(base)
  const capability = providerHost.accountCapabilities.get(provider)
  if (!capability) return env
  return capability.accountEnv(await capabilitySelection(capability), env)
}

export async function selectedAccount(
  provider: string
): Promise<SelectedAccount> {
  const capability = providerHost.accountCapabilities.get(provider)
  if (!capability) return { name: "default" }
  const selection = await capabilitySelection(capability)
  const env = await capability.accountEnv(
    selection,
    childProcessEnv(process.env)
  )
  return capability.selectedAccount(selection, env)
}

/* ------------------------------------------------------------ usage */

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
interface CachedUsage {
  usage: AccountUsage
  expiresAt: number
}

const usageCache = new Map<string, CachedUsage>()
/** The latest good reading per account, kept through failed refreshes. */
const lastGood = new Map<string, Extract<AccountUsage, { status: "ok" }>>()
const usageReads = new Map<string, Promise<AccountUsage>>()
/** Who each `harness:name` was signed in as when the accounts were last listed. */
const usageIdentity = new Map<string, string>()
const usageListeners = new Set<(harness: string, name: string, usage: AccountUsage) => void>()
const USAGE_FRESH_MS = 60_000
const USAGE_RETRY_MS = 15_000
/** How old a kept reading may be before a failed refresh stops covering for it. */
const LAST_GOOD_MS = 30 * 60_000

function storeUsage(key: string, usage: AccountUsage, now: number, retry = usage.status !== "ok"): void {
  const expiresAt = Math.min(now + (retry ? USAGE_RETRY_MS : USAGE_FRESH_MS), nextReset(usage, now) ?? Infinity)
  usageCache.set(key, { usage, expiresAt })
  if (usage.status === "ok" && !retry) lastGood.set(key, usage)
}

/** Readings that change outside a request: a live session's limits. */
export function onAccountUsage(listener: (harness: string, name: string, usage: AccountUsage) => void): () => void {
  usageListeners.add(listener)
  return () => usageListeners.delete(listener)
}

export async function accountUsage(
  provider: AccountProvider,
  name: string
): Promise<AccountUsage> {
  const key = `${provider}:${name}`
  const cached = usageCache.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.usage
  const reading = usageReads.get(key)
  if (reading) return reading
  const read: Promise<AccountUsage> = readUsage(provider, name)
    .then((result) => settleUsage(key, read, result))
    .finally(() => {
      if (usageReads.get(key) === read) usageReads.delete(key)
    })
  usageReads.set(key, read)
  return read
}

/**
 * A read that a newer one, a live reading or a new login superseded while it
 * was in flight answers its caller but leaves the cache alone.
 */
function settleUsage(key: string, read: Promise<AccountUsage>, result: AccountUsage): AccountUsage {
  const at = Date.now()
  const usage: AccountUsage = result.status === "ok" ? { ...result, readAt: at } : result
  const good = lastGood.get(key)
  const kept = usage.status === "error" && good !== undefined && !hasReset(good, at) &&
    at - (good.readAt ?? 0) < LAST_GOOD_MS ? good : undefined
  if (usageReads.get(key) === read) storeUsage(key, kept ?? usage, at, kept !== undefined || usage.status !== "ok")
  return kept ?? usage
}

async function readUsage(provider: AccountProvider, name: string): Promise<AccountUsage> {
  const capability = providerHost.accountCapabilities.get(provider)
  if (!capability)
    return { status: "unavailable", detail: `Native usage is unavailable for ${provider}` }
  return capability.accountUsage(name).catch((error) => ({
    status: "error" as const,
    detail: error instanceof Error ? error.message : String(error),
  }))
}

function forgetUsage(key: string): void {
  usageCache.delete(key)
  usageReads.delete(key)
  lastGood.delete(key)
}

/** A different login under the same account name: its old reading belongs to someone else. */
function noteIdentities(accounts: readonly HarnessAccount[]): void {
  for (const account of accounts) {
    const key = `${account.harness}:${account.name}`
    const identity = account.email ?? account.plan ?? ""
    const known = usageIdentity.get(key)
    if (known !== undefined && known !== identity) forgetUsage(key)
    usageIdentity.set(key, identity)
  }
}

/**
 * A live session reported its account's limits. Amends the cached reading
 * and tells listeners, so the meter moves without a request. With no whole
 * reading to amend, the account is read again instead.
 */
export function observeAccountUsage(
  harness: string,
  name: string,
  amend: (previous: AccountUsage | undefined) => AccountUsage | undefined
): void {
  const key = `${harness}:${name}`
  const now = Date.now()
  const usage = amend(usageCache.get(key)?.usage ?? lastGood.get(key))
  if (!usage) {
    void accountUsage(harness, name).then((read) => {
      for (const listener of usageListeners) listener(harness, name, read)
    })
    return
  }
  usageReads.delete(key)
  storeUsage(key, usage, now)
  for (const listener of usageListeners) listener(harness, name, usage)
}

/**
 * Spend one reset credit. Whatever the answer, or none, the reading taken
 * before is no longer trusted: a lost reply may still have spent it.
 */
export async function useResetCredit(
  harness: AccountProvider,
  name: string,
  attempt: string
): Promise<ResetCreditOutcome> {
  const capability = providerHost.accountCapabilities.get(harness)
  if (!capability?.useResetCredit) throw new Error(`${capability?.label ?? harness} has no reset credits to use`)
  try {
    return await capability.useResetCredit(name, attempt)
  } finally {
    forgetUsage(`${harness}:${name}`)
  }
}

const spentAt = new Map<string, number>()
const SPENT_THROTTLE_MS = 20_000

/**
 * The harness was just used — a turn ended in Mako, or its session store
 * changed from anywhere — so its readings are old. Drops them and says
 * whether windows should read again: at most once per `throttleMs` per
 * harness, so a busy session does not become a stream of requests.
 */
export function accountUsageSpent(harness: string, throttleMs = SPENT_THROTTLE_MS): boolean {
  if (!providerHost.accountCapabilities.get(harness)) return false
  const last = spentAt.get(harness) ?? 0
  if (Date.now() - last < throttleMs) return false
  spentAt.set(harness, Date.now())
  for (const key of usageCache.keys())
    if (key.startsWith(`${harness}:`)) usageCache.delete(key)
  return true
}

/* ------------------------------------------------------------ suggestion */

function spentPercent(usage: AccountUsage): number | null {
  if (usage.status !== "ok") return null
  return bindingWindow(windowsAt(usage.windows, Date.now()))?.usedPercent ?? 0
}

/**
 * The account with the most headroom in whichever window binds it first.
 *
 * Groundwork for automatic routing; today it powers the suggestion below.
 * Only accounts whose usage endpoint answered are candidates — an account
 * with a stale token might be empty or might be exhausted, and guessing is
 * worse than not suggesting.
 */
export async function pickAccount(
  harness: AccountHarness
): Promise<{ name: string; usedPercent: number } | null> {
  let best: { name: string; usedPercent: number } | null = null
  for (const account of await harnessAccounts(harness)) {
    const used = spentPercent(await accountUsage(harness, account.name))
    if (used === null) continue
    if (!best || used < best.usedPercent)
      best = { name: account.name, usedPercent: used }
  }
  return best
}

const suggestedAt = new Map<string, number>()
const SUGGEST_THROTTLE_MS = 60 * 60 * 1000

/**
 * Whether the user should hear about switching, and the words to say it in.
 *
 * Fires when the *active* account is nearly out of any window and some other
 * account has real headroom. Never switches by itself: an account is money,
 * and money moves are the user's to make. Throttled to once an hour per
 * harness — a nag repeated is a nag ignored.
 */
export async function switchSuggestion(
  harness: AccountHarness
): Promise<string | null> {
  const last = suggestedAt.get(harness) ?? 0
  if (Date.now() - last < SUGGEST_THROTTLE_MS) return null
  const active = (await harnessAccounts(harness)).find(
    (account) => account.active
  )
  if (!active) return null
  const used = spentPercent(await accountUsage(harness, active.name))
  if (used === null || used < 90) return null
  const best = await pickAccount(harness)
  if (!best || best.name === active.name || best.usedPercent >= 70) return null
  const capability = selectableCapability(harness)
  suggestedAt.set(harness, Date.now())
  return `${capability.label} account "${active.name}" is at ${Math.round(used)}% of its window — "${best.name}" is at ${Math.round(best.usedPercent)}%. Switch in Settings → Agents.`
}

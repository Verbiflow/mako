/**
 * Several accounts per harness, one machine.
 *
 * Selectable adapters route isolated credential homes through their native
 * environment. The default account is the CLI's ordinary login, the same one
 * a terminal uses, whatever config-dir or token overrides the shell exported.
 * Other accounts are Mako-owned profiles signed into directly. Importing an
 * existing login remains available, but a copied OAuth login can refresh
 * independently.
 *
 * Managed profiles retain their original settings/store home. Sessions and
 * compatible tools remain shared; credential files and auth-storage policy
 * stay private. An adapter declares native sign-in support and returns a
 * secret-free command for its runtime. Native credential formats, OS stores
 * and profile preparation belong to that adapter, never this facade.
 *
 * Usage comes from the providers' own endpoints: Claude's OAuth usage API,
 * ChatGPT's backend usage API for Codex and OpenCode, Cursor's dashboard
 * service, Grok's ACP billing method and Devin's seat status. Each reports
 * whatever windows its plan has — five hours, a day, a week, a month — so
 * usage is a list, never a fixed pair. A stale token is a classified state,
 * not an error toast. Native refresh remains the provider's responsibility;
 * a stale token does not establish that a later refresh will succeed.
 *
 * Provider-specific parsing, capture, environment, and usage live in the
 * independent account capability registry. This file intentionally remains
 * the stable compatibility facade used by IPC and process launchers.
 */

import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type {
  AccountCatalog,
  AccountLoginResult,
  AccountProviderInfo,
  AccountHarness,
  AccountProvider,
  AccountRemoval,
  AccountUsage,
  HarnessAccount,
  ResetCreditOutcome,
  SelectedAccount,
} from "./account-types.js"
import {
  accountDir,
  accountsRoot,
  childProcessEnv,
  clearLoginPending,
  loginPending,
  readSelection,
  withAccountMutation,
  writeSelection,
} from "./accounts-common.js"
import type {
  AccountLoginLaunch,
  AccountLoginTarget,
  ProviderAccountCapability,
  SelectableAccountCapability,
} from "./providers/account-capability.js"
import { providerHost } from "./providers/index.js"
import { hostWarn } from "./host-log.js"
import {
  bindingWindow,
  hasReset,
  nextReset,
  windowsAt,
} from "./contracts/account-usage.js"

export type {
  AccountCatalog,
  AccountLogin,
  AccountLoginResult,
  AccountProviderInfo,
  AccountHarness,
  AccountProvider,
  AccountRemoval,
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
  const selection = await capabilitySelection(capability).catch(() => null)
  let accounts: HarnessAccount[]
  try {
    accounts = await capability.listAccounts(selection)
  } catch {
    return []
  }
  // A selection whose account is gone stays on screen, so new sessions
  // refusing to start has a row to explain it and another to switch to.
  if (selection !== null && !accounts.some((account) => account.name === selection))
    accounts.push({ harness: capability.provider, name: selection, dir: "", active: true, source: "mako", route: "managed", missing: true })
  return accounts
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
      .map((capability) => {
        const info: AccountProviderInfo = {
          provider: capability.provider,
          label: capability.label,
          mode: capability.mode,
          loginCommand: capability.loginCommand,
        }
        if (capability.mode === "selectable" && capability.nativeLogin) info.nativeLogin = true
        if (capability.readOnlyReason) info.readOnlyReason = capability.readOnlyReason
        return info
      }),
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
  await mutateAccount(harness, async () => {
    const capability = selectableCapability(harness)
    if (!capability.captureAccount)
      throw new Error(`${capability.label} logins can't be copied. Add the account by signing in.`)
    await capability.captureAccount(name)
    forgetUsage(`${harness}:${name}`)
  })
}

/** Serialize identity mutations per provider so selecting and deleting cannot race. */
const accountMutations = new Map<string, Promise<unknown>>()
async function mutateAccount<T>(
  provider: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = accountMutations.get(provider) ?? Promise.resolve()
  const task = previous
    .catch(() => undefined)
    .then(() => withAccountMutation(provider, run))
  accountMutations.set(provider, task)
  try {
    return await task
  } finally {
    if (accountMutations.get(provider) === task)
      accountMutations.delete(provider)
  }
}

export async function removeAccount(
  harness: AccountHarness,
  name: string
): Promise<AccountRemoval> {
  return mutateAccount(harness, async () => {
    const capability = selectableCapability(harness)
    // Removing credentials must never choose a different paying identity.
    // The user first selects another saved account or explicitly selects the
    // CLI login. Refusing also preserves selection if native deletion fails.
    if ((await readSelection(harness)) === name)
      throw new Error(
        "This account is selected. Choose another account before removing it."
      )
    const removal = await capability.removeAccount(name)
    forgetUsage(`${harness}:${name}`)
    return removal
  })
}

/* ------------------------------------------------------------ selection */

function nativeLoginCapability(harness: AccountHarness) {
  const capability = selectableCapability(harness)
  if (!capability.nativeLogin) throw new Error(`${capability.label} accounts can't be added in Mako yet.`)
  return capability
}

/**
 * Prepare one native sign-in without copying or changing any other login:
 * a new empty profile, or an account Mako keeps whose login expired.
 * Profiles left by an abandoned sign-in go first; the caller runs one
 * sign-in per provider at a time.
 */
export async function prepareAccountLogin(
  harness: AccountHarness,
  target: AccountLoginTarget
): Promise<{ launch: AccountLoginLaunch; previousEmail?: string }> {
  return mutateAccount(harness, async () => {
    const capability = nativeLoginCapability(harness)
    const root = join(accountsRoot(), harness)
    for (const entry of await readdir(root).catch(() => []))
      if (!entry.startsWith(".") && entry !== target.name && loginPending(join(root, entry)))
        await capability.removeAccount(entry)
    if (!target.renew) return { launch: await capability.prepareAccountLogin(target) }
    const listed = await capability.listAccounts(await readSelection(harness))
    const account = listed.find((entry) => entry.name === target.name && entry.source === "mako" && !entry.missing)
    if (!account) throw new Error("That account isn't one Mako keeps. Refresh to see your accounts.")
    const launch = await capability.prepareAccountLogin(target)
    return account.email === undefined ? { launch } : { launch, previousEmail: account.email }
  })
}

/**
 * Whether the sign-in has landed in the profile yet, for a CLI that keeps
 * running after it succeeds. Changes nothing until it has.
 */
export async function accountLoginLanded(harness: AccountHarness, target: AccountLoginTarget): Promise<boolean> {
  const capability = nativeLoginCapability(harness)
  const confirm = capability.confirmAccountLogin?.bind(capability)
  if (!confirm) return false
  return mutateAccount(harness, () => confirm(target).then(() => true, () => false))
}

/**
 * The native sign-in finished: prove the profile is signed in, then list it.
 * A new login Mako already has is discarded and named instead, so signing in
 * twice as one person never makes two rows that spend the same plan. An
 * account signed in again keeps its name and says if it is someone else now.
 */
export async function finishAccountLogin(
  harness: AccountHarness,
  target: AccountLoginTarget,
  options: { verify?: (env: NodeJS.ProcessEnv) => Promise<void>; confirmed?: boolean; previousEmail?: string }
): Promise<AccountLoginResult> {
  return mutateAccount(harness, async () => {
    const capability = nativeLoginCapability(harness)
    const { name } = target
    if (!options.confirmed) await capability.confirmAccountLogin?.(target)
    const env = await capability.accountEnv(name, childProcessEnv(process.env))
    await options.verify?.(env)
    if (!target.renew) await clearLoginPending(accountDir(harness, name))
    forgetUsage(`${harness}:${name}`)
    const listed = await capability.listAccounts(await readSelection(harness))
    const email = listed.find((account) => account.name === name)?.email
    if (target.renew) {
      const result: AccountLoginResult = { status: "renewed", name }
      if (email !== undefined) result.email = email
      if (options.previousEmail !== undefined && email !== undefined && email !== options.previousEmail)
        result.previousEmail = options.previousEmail
      return result
    }
    const existing = email === undefined ? undefined : listed.find(
      (account) => account.name !== name && account.email === email && !account.missing
    )
    if (existing) {
      const { stillValid } = await capability.removeAccount(name)
      if (stillValid) hostWarn("accounts", "A duplicate sign-in's key could not be revoked", { harness, reason: stillValid.reason })
      return { status: "duplicate" as const, name: existing.name, email }
    }
    return email === undefined ? { status: "added" as const, name } : { status: "added" as const, name, email }
  })
}

/** A sign-in that will not finish leaves nothing behind; an account being signed in again keeps what it had. */
export async function discardAccountLogin(harness: AccountHarness, target: AccountLoginTarget): Promise<void> {
  await mutateAccount(harness, async () => {
    const capability = nativeLoginCapability(harness)
    await capability.abandonAccountLogin?.(target)
    if (!target.renew) await capability.removeAccount(target.name)
  })
}

/** `null` is the CLI's ordinary login, the one a terminal signs in to. */
export async function selectAccount(
  harness: AccountHarness,
  name: string | null
): Promise<void> {
  return mutateAccount(harness, async () => {
    const capability = selectableCapability(harness)
    if (name !== null)
      await capability.accountEnv(name, childProcessEnv(process.env))
    await writeSelection(harness, name)
  })
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
  return (await resolveAccountLaunch(provider, base, { trackCredential: false })).env
}

/** Host-only, prepared once for an execution. Never serialize the environment. */
export interface AccountLaunch {
  env: NodeJS.ProcessEnv
  account: SelectedAccount
  selection: { kind: "selectable"; name: string | null } | { kind: "observed" } | { kind: "unavailable" }
  /** Opaque configured-source equality. Host-only, never a native principal. */
  credential?: { name: string; revision: string }
}

export class ExecutionAccountChanged extends Error {
  readonly reason: "selection" | "credentials"
  constructor(reason: "selection" | "credentials") {
    super(reason === "selection"
      ? "The selected account changed. Reconnect this agent before sending; no prompt was dispatched and existing work was preserved."
      : "The account credentials changed. Reconnect this agent before sending; no prompt was dispatched and existing work was preserved.")
    this.name = "ExecutionAccountChanged"
    this.reason = reason
  }
}

/** The native process reported a different identity than the account it was launched with. */
export class ExecutionIdentityMismatch extends Error {
  constructor(principal: string, expected: string) {
    super(`This agent is signed in as ${principal}, not ${expected}, the account this session started with. Nothing was sent. Sign ${expected} in again in Settings › Agents, or choose the account it is signed in as.`)
    this.name = "ExecutionIdentityMismatch"
  }
}

/** The email Mako lists for an account, to compare with what its native process reports. */
export async function accountPrincipal(provider: string, name: string): Promise<string | undefined> {
  const capability = providerHost.accountCapabilities.get(provider)
  if (!capability) return undefined
  try {
    return (await capability.listAccounts(await capabilitySelection(capability))).find(account => account.name === name && !account.missing)?.email
  } catch {
    return undefined
  }
}

/** Resolve selection and its launch environment together under the identity lease.
 * This is configured identity, not proof of the identity reported by native code.
 */
export async function resolveAccountLaunch(
  provider: string,
  base: NodeJS.ProcessEnv,
  options: { trackCredential?: boolean } = {}
): Promise<AccountLaunch> {
  const env = childProcessEnv(base)
  const capability = providerHost.accountCapabilities.get(provider)
  if (!capability) return { env, account: { name: "default" }, selection: { kind: "unavailable" } }
  const resolve = async () => {
    const selection = await capabilitySelection(capability)
    const name = selection ?? "default"
    const before = options.trackCredential === false ? undefined : await capability.credentialRevision(name, env)
    const resolved = await capability.accountEnv(selection, env)
    const revision = options.trackCredential === false ? undefined : await capability.credentialRevision(name, env)
    if (before !== revision) throw new ExecutionAccountChanged("credentials")
    return { env: resolved, account: capability.selectedAccount(selection, resolved), selection: capability.mode === "selectable"
      ? { kind: "selectable" as const, name: selection }
      : { kind: "observed" as const }, credential: revision === undefined ? undefined : { name, revision } }
  }
  return capability.mode === "selectable" ? mutateAccount(provider, resolve) : resolve()
}

/** Linearizes new input against configured selection and credential revision.
 * Running work keeps its launch identity. Equality of the configured source
 * does not prove the principal reported by native code or OAuth refresh health. */
export async function assertAccountLaunch(provider: string, launch: AccountLaunch): Promise<void> {
  if (launch.selection.kind === "selectable" && await readSelection(provider) !== launch.selection.name)
    throw new ExecutionAccountChanged("selection")
  if (launch.credential) {
    const capability = providerHost.accountCapabilities.get(provider)
    if (!capability || await capability.credentialRevision(launch.credential.name, launch.env) !== launch.credential.revision)
      throw new ExecutionAccountChanged("credentials")
  }
}

/**
 * What a session paused on a sign-out is measured against: the account a
 * launch would use now, and a one-way digest of `account`'s credentials. A
 * changed digest says someone signed in; nothing can be read back from it.
 */
export async function signInState(provider: string, account: string): Promise<{ selected: string; credential: string }> {
  const capability = providerHost.accountCapabilities.get(provider)
  const selected = (capability && await capabilitySelection(capability)) ?? "default"
  const revision = await capability?.credentialRevision(account, childProcessEnv(process.env)).catch(() => undefined)
  return { selected, credential: createHash("sha256").update(`mako-sign-in\0${provider}\0${revision ?? ""}`).digest("hex").slice(0, 24) }
}

export async function selectedAccount(
  provider: string
): Promise<SelectedAccount> {
  return (await resolveAccountLaunch(provider, process.env, { trackCredential: false })).account
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
/** Effective credential equality remains host-only, independent of display name/email. */
const usageRevisions = new Map<string, string>()
/** Who each `harness:name` was signed in as when the accounts were last listed. */
const usageIdentity = new Map<string, string>()
const usageListeners = new Set<
  (harness: string, name: string, usage: AccountUsage) => void
>()
const USAGE_FRESH_MS = 60_000
const USAGE_RETRY_MS = 15_000
/** How old a kept reading may be before a failed refresh stops covering for it. */
const LAST_GOOD_MS = 30 * 60_000

function storeUsage(
  key: string,
  usage: AccountUsage,
  now: number,
  retry = usage.status !== "ok"
): void {
  const expiresAt = Math.min(
    now + (retry ? USAGE_RETRY_MS : USAGE_FRESH_MS),
    nextReset(usage, now) ?? Infinity
  )
  usageCache.set(key, { usage, expiresAt })
  if (usage.status === "ok" && !retry) lastGood.set(key, usage)
}

/** Readings that change outside a request: a live session's limits. */
export function onAccountUsage(
  listener: (harness: string, name: string, usage: AccountUsage) => void
): () => void {
  usageListeners.add(listener)
  return () => usageListeners.delete(listener)
}

export async function accountUsage(
  provider: AccountProvider,
  name: string
): Promise<AccountUsage> {
  const key = `${provider}:${name}`
  const capability = providerHost.accountCapabilities.get(provider)
  let revision: string | undefined
  try { revision = await capability?.credentialRevision(name) }
  catch { return { status: "error", detail: "The account credentials could not be read." } }
  if (revision !== undefined && usageRevisions.get(key) !== revision) {
    forgetUsage(key)
    usageRevisions.set(key, revision)
  }
  const cached = usageCache.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.usage
  const reading = usageReads.get(key)
  if (reading) return reading
  const read: Promise<AccountUsage> = readUsage(provider, name)
    .then(async (result) => {
      // A native refresh can rotate credentials while reading. Never cache a
      // result or carry last-good usage across that unacknowledged boundary.
      const after = await capability?.credentialRevision(name).catch(() => undefined)
      if (after !== revision) {
        if (usageReads.get(key) === read) forgetUsage(key)
        return result
      }
      return settleUsage(key, read, result)
    })
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
function settleUsage(
  key: string,
  read: Promise<AccountUsage>,
  result: AccountUsage
): AccountUsage {
  const at = Date.now()
  const usage: AccountUsage =
    result.status === "ok" ? { ...result, readAt: at } : result
  const good = lastGood.get(key)
  const kept =
    usageReads.get(key) === read &&
    usage.status === "error" &&
    good !== undefined &&
    !hasReset(good, at) &&
    at - (good.readAt ?? 0) < LAST_GOOD_MS
      ? good
      : undefined
  if (usageReads.get(key) === read)
    storeUsage(
      key,
      kept ?? usage,
      at,
      kept !== undefined || usage.status !== "ok"
    )
  return kept ?? usage
}

async function readUsage(
  provider: AccountProvider,
  name: string
): Promise<AccountUsage> {
  const capability = providerHost.accountCapabilities.get(provider)
  if (!capability)
    return {
      status: "unavailable",
      detail: `Native usage is unavailable for ${provider}`,
    }
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
  if (!capability?.useResetCredit)
    throw new Error(
      `${capability?.label ?? harness} has no reset credits to use`
    )
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
export function accountUsageSpent(
  harness: string,
  throttleMs = SPENT_THROTTLE_MS
): boolean {
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
  const other = (await harnessAccounts(harness)).find((account) => account.name === best.name)
  suggestedAt.set(harness, Date.now())
  return `${capability.label} account ${active.email ?? active.name} is at ${Math.round(used)}% of its window. ${other?.email ?? best.name} is at ${Math.round(best.usedPercent)}%. Switch in Settings → Agents.`
}

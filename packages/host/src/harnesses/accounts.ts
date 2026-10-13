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
 * independent account capability registry. `HarnessAccounts` is what IPC,
 * admission and the process launchers ask.
 */

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ProviderBinding } from "../contracts/conversation-control.js"
import type {
  AccountCatalog,
  AccountLoginResult,
  AccountProviderInfo,
  AccountHarness,
  AccountRemovalEvent,
  AccountRemovalOutcome,
  AccountUsage,
  HarnessAccount,
  SelectedAccount,
} from "../contracts/accounts.js"
import {
  accountDir,
  accountsRoot,
  clearLoginPending,
  loginPending,
  readSelection,
  withAccountMutation,
  writeSelection,
} from "./accounts-common.js"
import { childProcessEnv } from "../base/child-environment.js"
import type {
  AccountLoginLaunch,
  AccountLoginTarget,
  ProviderAccountCapability,
  SelectableAccountCapability,
} from "./account-capability.js"
import type { ProviderRegistry } from "./registry.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { AccountHolds, type AccountHold, type AccountHolder } from "./account-holds.js"
import { AccountUsageReadings } from "./account-usage-readings.js"
import { bindingWindow, windowsAt } from "../contracts/account-usage.js"

/** Host-only, prepared once for an execution. Never serialize the environment. */
export interface AccountLaunch {
  env: NodeJS.ProcessEnv
  account: SelectedAccount
  selection: { kind: "selectable"; name: string | null } | { kind: "observed" } | { kind: "unavailable" }
  /** Opaque configured-source equality. Host-only, never a native principal. */
  credential?: { name: string; revision: string }
  /** Keeps a Mako-kept account's credentials until the launched work ends. */
  hold?: AccountHold
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

const SUGGEST_THROTTLE_MS = 60 * 60 * 1000

function removalMarker(provider: string, name: string): string {
  accountDir(provider, name)
  return join(accountsRoot(), "removing", provider, `${name}.json`)
}

/** Names whose removal waits; a marker is the whole record, read the same by every host. */
async function removingNames(provider: string): Promise<ReadonlySet<string>> {
  const files = await readdir(join(accountsRoot(), "removing", provider)).catch(() => [])
  return new Set(files.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -".json".length)))
}

function capabilitySelection(capability: ProviderAccountCapability): Promise<string | null> {
  return capability.mode === "selectable" ? readSelection(capability.provider) : Promise.resolve(null)
}

function spentPercent(usage: AccountUsage): number | null {
  if (usage.status !== "ok") return null
  return bindingWindow(windowsAt(usage.windows, Date.now()))?.usedPercent ?? 0
}

/** Every harness's accounts as one host sees them: listing, sign-in, selection, removal, launch and usage. */
export class HarnessAccounts {
  /** Which running work holds each account Mako keeps. */
  readonly holds = new AccountHolds()
  /** Each account's usage, read from its provider on demand. */
  readonly usage: AccountUsageReadings
  /** Serializes identity mutations per provider so selecting and deleting cannot race. */
  private readonly mutations = new Map<string, Promise<unknown>>()
  private readonly removalListeners = new Set<(harness: string, name: string, event: AccountRemovalEvent) => void>()
  private readonly suggestedAt = new Map<string, number>()
  private readonly capabilities: ProviderRegistry<ProviderAccountCapability>

  constructor(capabilities: ProviderRegistry<ProviderAccountCapability>) {
    this.capabilities = capabilities
    this.usage = new AccountUsageReadings(capabilities)
    this.holds.onReleased((provider, name) => {
      // Released before this check, so a removal marked after it reads no hold.
      if (existsSync(removalMarker(provider, name))) void this.completeRemoval(provider, name)
    })
  }

  /* ------------------------------------------------------------ listing */

  async list(): Promise<HarnessAccount[]> {
    const lists = await Promise.all(this.capabilities.list().map((capability) => this.capabilityAccounts(capability)))
    const accounts = lists.flat()
    this.usage.noteIdentities(accounts)
    return accounts
  }

  async catalog(): Promise<AccountCatalog> {
    return {
      providers: this.capabilities.list().map((capability) => {
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
      accounts: await this.list(),
    }
  }

  /** The harness's own name for its accounts, as Settings shows it. */
  label(harness: string): string {
    return this.capabilities.get(harness)?.label ?? harness
  }

  /* ------------------------------------------------------------ capture */

  /**
   * Capture the harness's *current* login as a named account.
   *
   * Sign into the other account with the CLI the ordinary way, capture, and
   * switch back — browser OAuth is a dance only the CLI itself can drive.
   */
  async capture(harness: AccountHarness, name: string): Promise<void> {
    await this.mutate(harness, async () => {
      const capability = this.selectable(harness)
      if (!capability.captureAccount)
        throw new Error(`${capability.label} logins can't be copied. Add the account by signing in.`)
      await capability.captureAccount(name)
      this.usage.forget(harness, name)
    })
  }

  /* ------------------------------------------------------------ removal */

  /**
   * Removing an account never pulls credentials from under running work.
   *
   * With nothing holding it, the account goes at once. Otherwise a marker
   * records the request: the account can't be selected or signed in again,
   * idle sessions on it let go now and busy ones when their work ends, and the
   * last holder to let go — in this Mako or another sharing ~/.mako — finishes
   * the removal. A marker left by a quit finishes at the next start. Keep
   * withdraws it.
   */
  onRemoval(listener: (harness: string, name: string, event: AccountRemovalEvent) => void): () => void {
    this.removalListeners.add(listener)
    return () => this.removalListeners.delete(listener)
  }

  async remove(harness: AccountHarness, name: string): Promise<AccountRemovalOutcome> {
    const outcome = await this.mutate(harness, async (): Promise<AccountRemovalOutcome> => {
      const capability = this.selectable(harness)
      // Removing credentials must never choose a different paying identity.
      // The user first selects another saved account or explicitly selects the
      // CLI login. Refusing also preserves selection if native deletion fails.
      if ((await readSelection(harness)) === name)
        throw new Error("This account is selected. Choose another account before removing it.")
      // The marker goes before holds are read: a holder letting go meanwhile
      // either finds it and finishes the removal, or is already gone below.
      const marker = removalMarker(harness, name)
      await mkdir(dirname(marker), { recursive: true, mode: 0o700 })
      await writeFile(marker, JSON.stringify({ version: 1, requestedAt: new Date().toISOString() }), { mode: 0o600 })
      if (await this.held(harness, name)) return { status: "pending" }
      return this.finishRemoval(capability, name)
    })
    if (outcome.status === "pending") {
      hostLog("accounts", "removal waits for work on the account", { harness, holders: this.holds.holders(harness, name).length })
      this.reportRemoval(harness, name, outcome)
    }
    return outcome
  }

  /** Removals a quit left waiting finish now if nothing else holds them. */
  async completePendingRemovals(): Promise<void> {
    const providers = await readdir(join(accountsRoot(), "removing")).catch(() => [])
    await Promise.all(providers.map(async (provider) => {
      for (const name of await removingNames(provider)) await this.completeRemoval(provider, name)
    }))
  }

  /** Withdraw a pending removal. False when it already finished. */
  async keep(harness: AccountHarness, name: string): Promise<boolean> {
    const kept = await this.mutate(harness, async () => {
      const marker = removalMarker(harness, name)
      if (!existsSync(marker)) return false
      await rm(marker, { force: true })
      return true
    })
    if (kept) this.reportRemoval(harness, name, { status: "kept" })
    return kept
  }

  /** Whether a removal waits on this account. */
  removalPending(provider: string, name: string): boolean {
    return existsSync(removalMarker(provider, name))
  }

  /** Who holds the account now, for the confirmation; this host's holders and whether another host has any. */
  async removalHolders(harness: AccountHarness, name: string): Promise<{ holders: AccountHolder[]; elsewhere: boolean }> {
    accountDir(harness, name)
    return { holders: this.holds.holders(harness, name), elsewhere: await this.holds.heldElsewhere(harness, name) }
  }

  /* ------------------------------------------------------------ sign-in */

  /**
   * Prepare one native sign-in without copying or changing any other login:
   * a new empty profile, or an account Mako keeps whose login expired.
   * Profiles left by an abandoned sign-in go first; the caller runs one
   * sign-in per provider at a time.
   */
  async prepareLogin(harness: AccountHarness, target: AccountLoginTarget): Promise<{ launch: AccountLoginLaunch; previousEmail?: string }> {
    return this.mutate(harness, async () => {
      const capability = this.nativeLogin(harness)
      const root = join(accountsRoot(), harness)
      for (const entry of await readdir(root).catch(() => []))
        if (!entry.startsWith(".") && entry !== target.name && loginPending(join(root, entry)))
          await capability.removeAccount(entry)
      if (!target.renew) return { launch: await capability.prepareAccountLogin(target) }
      this.refuseRemoving(harness, target.name)
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
  async loginLanded(harness: AccountHarness, target: AccountLoginTarget): Promise<boolean> {
    const capability = this.nativeLogin(harness)
    const confirm = capability.confirmAccountLogin?.bind(capability)
    if (!confirm) return false
    return this.mutate(harness, () => confirm(target).then(() => true, () => false))
  }

  /**
   * The native sign-in finished: prove the profile is signed in, then list it.
   * A new login Mako already has is discarded and named instead, so signing in
   * twice as one person never makes two rows that spend the same plan. An
   * account signed in again keeps its name and says if it is someone else now.
   */
  async finishLogin(
    harness: AccountHarness,
    target: AccountLoginTarget,
    options: { verify?: (env: NodeJS.ProcessEnv) => Promise<void>; confirmed?: boolean; previousEmail?: string }
  ): Promise<AccountLoginResult> {
    return this.mutate(harness, async () => {
      const capability = this.nativeLogin(harness)
      const { name } = target
      if (!options.confirmed) await capability.confirmAccountLogin?.(target)
      const env = await capability.accountEnv(name, childProcessEnv(process.env))
      await options.verify?.(env)
      if (!target.renew) await clearLoginPending(accountDir(harness, name))
      this.usage.forget(harness, name)
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

  /**
   * The native sign-in finished into a profile made for someone else to keep: prove it as `finishLogin` does, hand
   * its environment to `use`, then remove the profile. Nothing is listed here, and nothing stays.
   */
  async useLogin(
    harness: AccountHarness,
    target: AccountLoginTarget,
    options: { verify?: (env: NodeJS.ProcessEnv) => Promise<void>; confirmed?: boolean },
    use: (env: NodeJS.ProcessEnv) => Promise<{ email?: string }>
  ): Promise<AccountLoginResult> {
    if (target.renew) throw new Error("A sign-in handed on is always a new profile")
    return this.mutate(harness, async () => {
      const capability = this.nativeLogin(harness)
      try {
        if (!options.confirmed) await capability.confirmAccountLogin?.(target)
        const env = await capability.accountEnv(target.name, childProcessEnv(process.env))
        await options.verify?.(env)
        const { email } = await use(env)
        return email === undefined ? { status: "connected" as const } : { status: "connected" as const, email }
      } finally {
        await capability.removeAccount(target.name)
      }
    })
  }

  /** A sign-in that will not finish leaves nothing behind; an account being signed in again keeps what it had. */
  async discardLogin(harness: AccountHarness, target: AccountLoginTarget): Promise<void> {
    await this.mutate(harness, async () => {
      const capability = this.nativeLogin(harness)
      await capability.abandonAccountLogin?.(target)
      if (!target.renew) await capability.removeAccount(target.name)
    })
  }

  /* ------------------------------------------------------------ selection */

  /** `null` is the CLI's ordinary login, the one a terminal signs in to. */
  async select(harness: AccountHarness, name: string | null): Promise<void> {
    return this.mutate(harness, async () => {
      const capability = this.selectable(harness)
      if (name !== null) {
        this.refuseRemoving(harness, name)
        await capability.accountEnv(name, childProcessEnv(process.env))
      }
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
  async env(provider: string, base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    return (await this.launch(provider, base, { trackCredential: false })).env
  }

  /**
   * The environment the account a binding ran on launches with, not the one
   * selected now, to find where its native session lives. Holds nothing. An
   * account that is gone or signed out falls back to the CLI's own, which
   * shares every harness's session store.
   */
  async bindingEnv(binding: ProviderBinding): Promise<NodeJS.ProcessEnv> {
    const base = childProcessEnv(process.env)
    const capability = this.capabilities.get(binding.provider)
    const account = binding.executionContext?.account
    if (!capability || account?.kind !== "configured" || !account.managed) return base
    return capability.accountEnv(account.name, base).catch(() => base)
  }

  /* ------------------------------------------------------------ launch */

  /** The email Mako lists for an account, to compare with what its native process reports. */
  async principal(provider: string, name: string): Promise<string | undefined> {
    const capability = this.capabilities.get(provider)
    if (!capability) return undefined
    try {
      return (await capability.listAccounts(await capabilitySelection(capability))).find(account => account.name === name && !account.missing)?.email
    } catch {
      return undefined
    }
  }

  /** Resolve selection and its launch environment together under the identity lease.
   * This is configured identity, not proof of the identity reported by native code.
   * A `holder` keeps the account from being removed until it releases the
   * launch's `hold`; work that outlives the call must pass one.
   */
  async launch(
    provider: string,
    base: NodeJS.ProcessEnv,
    options: { trackCredential?: boolean; holder?: AccountHolder } = {}
  ): Promise<AccountLaunch> {
    const env = childProcessEnv(base)
    const capability = this.capabilities.get(provider)
    if (!capability) return { env, account: { name: "default" }, selection: { kind: "unavailable" } }
    const resolve = async () => {
      const selection = await capabilitySelection(capability)
      const name = selection ?? "default"
      const before = options.trackCredential === false ? undefined : await capability.credentialRevision(name, env)
      const resolved = await capability.accountEnv(selection, env)
      const revision = options.trackCredential === false ? undefined : await capability.credentialRevision(name, env)
      if (before !== revision) throw new ExecutionAccountChanged("credentials")
      const launch: AccountLaunch = { env: resolved, account: capability.selectedAccount(selection, resolved), selection: capability.mode === "selectable"
        ? { kind: "selectable" as const, name: selection }
        : { kind: "observed" as const }, credential: revision === undefined ? undefined : { name, revision } }
      // The CLI's own login is never Mako's to remove; only kept accounts are held.
      if (options.holder && capability.mode === "selectable" && selection !== null)
        launch.hold = this.holds.hold(provider, selection, options.holder)
      return launch
    }
    return capability.mode === "selectable" ? this.mutate(provider, resolve) : resolve()
  }

  /** Linearizes new input against configured selection and credential revision.
   * Running work keeps its launch identity. Equality of the configured source
   * does not prove the principal reported by native code or OAuth refresh health. */
  async assertLaunch(provider: string, launch: AccountLaunch): Promise<void> {
    if (launch.selection.kind === "selectable" && await readSelection(provider) !== launch.selection.name)
      throw new ExecutionAccountChanged("selection")
    if (launch.credential) {
      const capability = this.capabilities.get(provider)
      if (!capability || await capability.credentialRevision(launch.credential.name, launch.env) !== launch.credential.revision)
        throw new ExecutionAccountChanged("credentials")
    }
  }

  /**
   * What a session paused on a sign-out is measured against: the account a
   * launch would use now, and a one-way digest of `account`'s credentials. A
   * changed digest says someone signed in; nothing can be read back from it.
   */
  async signInState(provider: string, account: string): Promise<{ selected: string; credential: string }> {
    const capability = this.capabilities.get(provider)
    const selected = (capability && await capabilitySelection(capability)) ?? "default"
    const revision = await capability?.credentialRevision(account, childProcessEnv(process.env)).catch(() => undefined)
    return { selected, credential: createHash("sha256").update(`mako-sign-in\0${provider}\0${revision ?? ""}`).digest("hex").slice(0, 24) }
  }

  /* ------------------------------------------------------------ suggestion */

  /**
   * Whether the user should hear about switching, and the words to say it in.
   *
   * Fires when the *active* account is nearly out of any window and some other
   * account has real headroom. Never switches by itself: an account is money,
   * and money moves are the user's to make. Throttled to once an hour per
   * harness — a nag repeated is a nag ignored.
   */
  async switchSuggestion(harness: AccountHarness): Promise<string | null> {
    const last = this.suggestedAt.get(harness) ?? 0
    if (Date.now() - last < SUGGEST_THROTTLE_MS) return null
    const accounts = await this.harnessAccounts(harness)
    const active = accounts.find((account) => account.active)
    if (!active) return null
    const used = spentPercent(await this.usage.read(harness, active.name))
    if (used === null || used < 90) return null
    const best = await this.mostHeadroom(accounts)
    if (!best || best.name === active.name || best.usedPercent >= 70) return null
    const capability = this.selectable(harness)
    const other = accounts.find((account) => account.name === best.name)
    this.suggestedAt.set(harness, Date.now())
    return `${capability.label} account ${active.email ?? active.name} is at ${Math.round(used)}% of its window. ${other?.email ?? best.name} is at ${Math.round(best.usedPercent)}%. Switch in Settings → Agents.`
  }

  /**
   * The account with the most headroom in whichever window binds it first.
   * Only accounts whose usage endpoint answered are candidates — an account
   * with a stale token might be empty or might be exhausted, and guessing is
   * worse than not suggesting.
   */
  private async mostHeadroom(accounts: readonly HarnessAccount[]): Promise<{ name: string; usedPercent: number } | null> {
    let best: { name: string; usedPercent: number } | null = null
    for (const account of accounts) {
      const used = spentPercent(await this.usage.read(account.harness, account.name))
      if (used === null) continue
      if (!best || used < best.usedPercent) best = { name: account.name, usedPercent: used }
    }
    return best
  }

  /* ------------------------------------------------------------ internals */

  private selectable(provider: string): SelectableAccountCapability {
    const capability = this.capabilities.get(provider)
    if (!capability || capability.mode !== "selectable") throw new Error(`Provider ${provider} does not support account selection`)
    return capability
  }

  private nativeLogin(harness: AccountHarness): Extract<SelectableAccountCapability, { nativeLogin: true }> {
    const capability = this.selectable(harness)
    if (!capability.nativeLogin) throw new Error(`${capability.label} accounts can't be added in Mako yet.`)
    return capability
  }

  private async capabilityAccounts(capability: ProviderAccountCapability): Promise<HarnessAccount[]> {
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
    if (capability.mode !== "selectable") return accounts
    const removing = await removingNames(capability.provider)
    return removing.size
      ? accounts.map((account) => removing.has(account.name) && account.source === "mako" ? { ...account, removing: true } : account)
      : accounts
  }

  private async harnessAccounts(harness: AccountHarness): Promise<HarnessAccount[]> {
    const capability = this.capabilities.get(harness)
    return capability ? this.capabilityAccounts(capability) : []
  }

  private async mutate<T>(provider: string, run: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(provider) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(() => withAccountMutation(provider, run))
    this.mutations.set(provider, task)
    try {
      return await task
    } finally {
      if (this.mutations.get(provider) === task) this.mutations.delete(provider)
    }
  }

  private reportRemoval(harness: string, name: string, event: AccountRemovalEvent): void {
    for (const listener of this.removalListeners) listener(harness, name, event)
  }

  /** Held by running work here or in another Mako. */
  private async held(provider: string, name: string): Promise<boolean> {
    return this.holds.holders(provider, name).length > 0 || this.holds.heldElsewhere(provider, name)
  }

  private refuseRemoving(provider: string, name: string): void {
    if (this.removalPending(provider, name))
      throw new Error("This account is being removed. Choose Keep to use it again.")
  }

  /** Delete the credentials and the marker. A failure leaves the account listed as it was. */
  private async finishRemoval(capability: SelectableAccountCapability, name: string): Promise<Extract<AccountRemovalOutcome, { status: "removed" }>> {
    try {
      const removal = await capability.removeAccount(name)
      this.usage.forget(capability.provider, name)
      return { status: "removed", ...removal }
    } finally {
      await rm(removalMarker(capability.provider, name), { force: true })
    }
  }

  /** Finish a pending removal once nothing holds the account; quiet when there is none. */
  private async completeRemoval(provider: string, name: string): Promise<void> {
    let event: AccountRemovalEvent | undefined
    try {
      event = await this.mutate(provider, async () => {
        const marker = removalMarker(provider, name)
        if (!existsSync(marker)) return undefined
        const capability = this.capabilities.get(provider)
        if (capability?.mode !== "selectable" || await this.held(provider, name)) return undefined
        // Selected meanwhile by a Mako that doesn't refuse it: that choice keeps it.
        if ((await readSelection(provider)) === name) {
          await rm(marker, { force: true })
          return { status: "kept" } satisfies AccountRemovalEvent
        }
        return this.finishRemoval(capability, name)
      })
    } catch (error) {
      hostWarn("accounts", "a pending removal failed", { harness: provider, error: error instanceof Error ? error.message : String(error) })
      event = { status: "failed", message: error instanceof Error ? error.message : String(error) }
    }
    if (!event) return
    hostLog("accounts", "pending removal finished", { harness: provider, status: event.status })
    this.reportRemoval(provider, name, event)
  }
}

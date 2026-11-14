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
import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
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
import { clearLoginPending, loginPending, readOptionalFile, type AccountRoot } from "./accounts-common.js"
import { childProcessEnv } from "../base/child-environment.js"
import { z } from "zod"
import { publishFile } from "../base/published-files.js"
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
import type { HostJobs, JobDemand } from "../base/host-jobs.js"
import { bindingWindow, LIMIT_NEAR_PERCENT, limitOffer, spentUntil, windowsAt, type AccountLimitOffer, type HarnessLimit } from "../contracts/account-usage.js"
import type { FallbackAccount } from "../contracts/fin-fallback.js"
import { AccountSignIns, SignInRecoveryWriteError, type VerifiedSignIn } from "./account-sign-ins.js"

/** Host-only, prepared once for an execution. Never serialize the environment. */
export interface AccountLaunch {
  env: NodeJS.ProcessEnv
  account: SelectedAccount
  /** `pinned`: the account one conversation runs on instead of the one selected (`launch`'s `account`). */
  selection: { kind: "selectable"; name: string | null; pinned?: true } | { kind: "observed" } | { kind: "unavailable" }
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
/** How long a warning counts for a window with no reset to read: a day. */
const WARNED_UNREAD_RESET_MS = 24 * 60 * 60_000
const WarnedSchema = z.record(z.string(), z.number())

/** What's kept of a provider's warnings: nothing, should it not read, which at worst warns once more. */
function readWarned(text: string | null): Record<string, number> {
  try { return WarnedSchema.parse(JSON.parse(text ?? "{}")) } catch { return {} }
}
/** How often a harness with one account is read for a warning: turns end far more often than a limit moves. */
const SOLE_ACCOUNT_READ_MS = 10 * 60_000
/** How often the watch for limits spent elsewhere looks for a harness that is due. */
const ELSEWHERE_TICK_MS = 60_000
/** The longest a failing read elsewhere waits before trying again. */
const ELSEWHERE_BACKOFF_MS = 60 * 60_000

function removalMarker(root: AccountRoot, provider: string, name: string): string {
  root.dir(provider, name)
  return join(root.removing(provider), `${name}.json`)
}

/** Names whose removal waits; a marker is the whole record, read the same by every host. */
async function removingNames(root: AccountRoot, provider: string): Promise<ReadonlySet<string>> {
  const files = await readdir(root.removing(provider)).catch(() => [])
  return new Set(files.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -".json".length)))
}

function capabilitySelection(root: AccountRoot, capability: ProviderAccountCapability): Promise<string | null> {
  return capability.mode === "selectable" ? root.readSelection(capability.provider) : Promise.resolve(null)
}

/** An account's name as a selection holds it: the CLI's own login is no selection. */
function selectionOf(account: string): string | null {
  return account === "default" ? null : account
}

function spentPercent(usage: AccountUsage): number | null {
  if (usage.status !== "ok") return null
  return bindingWindow(windowsAt(usage.windows, Date.now()))?.usedPercent ?? 0
}

/** Every harness's accounts as one host sees them: listing, sign-in, selection, removal, launch and usage. */
export class HarnessAccounts {
  /** Where this host keeps accounts, their selection and their leases. */
  readonly root: AccountRoot
  /** Which running work holds each account Mako keeps. */
  readonly holds: AccountHolds
  /** Each account's usage, read from its provider on demand. */
  readonly usage: AccountUsageReadings
  private readonly signIns: AccountSignIns
  /** Serializes identity mutations per provider so selecting and deleting cannot race. */
  private readonly mutations = new Map<string, Promise<unknown>>()
  private readonly removalListeners = new Set<(harness: string, name: string, event: AccountRemovalEvent) => void>()
  private readonly suggestedAt = new Map<string, number>()
  private readonly soleReadAt = new Map<string, number>()
  private gate: ((provider: string) => Promise<void>) | undefined
  private route: ((provider: string, env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv>) | undefined
  private readonly capabilities: ProviderRegistry<ProviderAccountCapability>

  constructor(capabilities: ProviderRegistry<ProviderAccountCapability>, root: AccountRoot) {
    this.capabilities = capabilities
    this.root = root
    this.holds = new AccountHolds(root)
    this.usage = new AccountUsageReadings(capabilities)
    this.signIns = new AccountSignIns(root)
    this.holds.onReleased((provider, name) => {
      // Released before this check, so a removal marked after it reads no hold.
      if (existsSync(removalMarker(root, provider, name))) void this.completeRemoval(provider, name)
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
   * last holder to let go — in this Mako or another sharing its account root — finishes
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
      if ((await this.root.readSelection(harness)) === name)
        throw new Error("This account is selected. Choose another account before removing it.")
      // The marker goes before holds are read: a holder letting go meanwhile
      // either finds it and finishes the removal, or is already gone below.
      const marker = removalMarker(this.root, harness, name)
      await publishFile(marker, JSON.stringify({ version: 1, requestedAt: new Date().toISOString() }), { mode: 0o600, dirMode: 0o700 })
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
    const providers = await readdir(this.root.removing()).catch(() => [])
    await Promise.all(providers.map(async (provider) => {
      for (const name of await removingNames(this.root, provider)) await this.completeRemoval(provider, name)
    }))
  }

  /** Withdraw a pending removal. False when it already finished. */
  async keep(harness: AccountHarness, name: string): Promise<boolean> {
    const kept = await this.mutate(harness, async () => {
      const marker = removalMarker(this.root, harness, name)
      if (!existsSync(marker)) return false
      await rm(marker, { force: true })
      return true
    })
    if (kept) this.reportRemoval(harness, name, { status: "kept" })
    return kept
  }

  /** Whether a removal waits on this account. */
  removalPending(provider: string, name: string): boolean {
    return existsSync(removalMarker(this.root, provider, name))
  }

  /** Who holds the account now, for the confirmation; this host's holders and whether another host has any. */
  async removalHolders(harness: AccountHarness, name: string): Promise<{ holders: AccountHolder[]; elsewhere: boolean }> {
    this.root.dir(harness, name)
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
      const root = this.root.provider(harness)
      for (const entry of await readdir(root).catch(() => []))
        if (!entry.startsWith(".") && entry !== target.name && loginPending(join(root, entry)))
          await capability.removeAccount(entry)
      if (!target.renew) return { launch: await capability.prepareAccountLogin(target) }
      this.refuseRemoving(harness, target.name)
      const listed = await capability.listAccounts(await this.root.readSelection(harness))
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
    const { result, receipt } = await this.mutate(harness, async () => {
      const result = await this.finishVerifiedLogin(harness, target, options)
      const verified = options.confirmed || options.verify !== undefined || this.nativeLogin(harness).confirmAccountLogin !== undefined
      let receipt: VerifiedSignIn | undefined
      if (verified && (result.status === "renewed" || result.status === "added")) {
        try { receipt = await this.signIns.keep(harness, result.name) }
        catch (error) { throw new SignInRecoveryWriteError({ error }) }
      }
      return { result, receipt }
    })
    // The account mutation is released before a resumed session tries to launch on it.
    if (receipt) this.signIns.publish(receipt)
    return result
  }

  onSignedIn(listener: (receipt: VerifiedSignIn) => void): () => void { return this.signIns.onSignedIn(listener) }
  signInProof(harness: string, account: string): VerifiedSignIn | undefined { return this.signIns.proof(harness, account) }
  signInSequence(harness: string): number | undefined { return this.signIns.sequence(harness) }

  private async finishVerifiedLogin(
    harness: AccountHarness,
    target: AccountLoginTarget,
    options: { verify?: (env: NodeJS.ProcessEnv) => Promise<void>; confirmed?: boolean; previousEmail?: string }
  ): Promise<AccountLoginResult> {
    const capability = this.nativeLogin(harness)
    const { name } = target
    if (!options.confirmed) await capability.confirmAccountLogin?.(target)
    const env = await capability.accountEnv(name, childProcessEnv(process.env))
    await options.verify?.(env)
    if (!target.renew) await clearLoginPending(this.root.dir(harness, name))
    this.usage.forget(harness, name)
    const listed = await capability.listAccounts(await this.root.readSelection(harness))
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
      await this.root.writeSelection(harness, name)
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
      return (await capability.listAccounts(await capabilitySelection(this.root, capability))).find(account => account.name === name && !account.missing)?.email
    } catch {
      return undefined
    }
  }

  /** Resolve selection and its launch environment together under the identity lease.
   * This is configured identity, not proof of the identity reported by native code.
   * A `holder` keeps the account from being removed until it releases the
   * launch's `hold`; work that outlives the call must pass one.
   */
  /**
   * What a harness's launch waits for first: after a wake, the sign-in Mako Cloud refreshed meanwhile, so a harness
   * never starts on a pair the cloud moved past. Reads that track no credential (the cloud's own sync) don't wait.
   */
  gateLaunches(gate: (provider: string) => Promise<void>): void {
    this.gate = gate
  }

  /** What every launch's environment goes through last: the person's model routes, for a harness whose adapter takes them. */
  routeLaunches(route: (provider: string, env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv>): void {
    this.route = route
  }

  /**
   * `account` runs this launch on one of the harness's accounts instead of the one selected: a Fin moved off an
   * account at its limit (`contracts/fin-fallback.ts`). Only a selectable harness takes it.
   */
  async launch(
    provider: string,
    base: NodeJS.ProcessEnv,
    options: { trackCredential?: boolean; holder?: AccountHolder; account?: string } = {}
  ): Promise<AccountLaunch> {
    if (options.trackCredential !== false) await this.gate?.(provider)
    const env = childProcessEnv(base)
    const capability = this.capabilities.get(provider)
    if (!capability) return { env: await this.routed(provider, env), account: { name: "default" }, selection: { kind: "unavailable" } }
    const pinned = capability.mode === "selectable" && options.account !== undefined ? selectionOf(options.account) : undefined
    const resolve = async () => {
      if (pinned) this.refuseRemoving(provider, pinned)
      const selection = pinned !== undefined ? pinned : await capabilitySelection(this.root, capability)
      const name = selection ?? "default"
      const before = options.trackCredential === false ? undefined : await capability.credentialRevision(name, env)
      const resolved = await this.routed(provider, await capability.accountEnv(selection, env))
      const revision = options.trackCredential === false ? undefined : await capability.credentialRevision(name, env)
      if (before !== revision) throw new ExecutionAccountChanged("credentials")
      const launch: AccountLaunch = { env: resolved, account: capability.selectedAccount(selection, resolved), selection: capability.mode === "selectable"
        ? { kind: "selectable" as const, name: selection, ...(pinned !== undefined && { pinned: true as const }) }
        : { kind: "observed" as const }, credential: revision === undefined ? undefined : { name, revision } }
      // The CLI's own login is never Mako's to remove; only kept accounts are held.
      if (options.holder && capability.mode === "selectable" && selection !== null)
        launch.hold = this.holds.hold(provider, selection, options.holder)
      return launch
    }
    return capability.mode === "selectable" ? this.mutate(provider, resolve) : resolve()
  }

  /** `env` with the routes `provider` takes; a route that can't be applied never stops the launch. */
  private async routed(provider: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    if (!this.route) return env
    try {
      return await this.route(provider, env)
    } catch (error) {
      hostWarn("model-routes", "routes were not applied", { harness: provider, error: error instanceof Error ? error.message : String(error) })
      return env
    }
  }

  /** Linearizes new input against configured selection and credential revision.
   * Running work keeps its launch identity. Equality of the configured source
   * does not prove the principal reported by native code or OAuth refresh health.
   * `pinned` is the account the conversation runs on now instead of the selected one; a pin set or cleared since
   * the launch changes it as a selection would. */
  async assertLaunch(provider: string, launch: AccountLaunch, pinned?: string): Promise<void> {
    const wanted = pinned !== undefined && this.capabilities.get(provider)?.mode === "selectable" ? selectionOf(pinned) : undefined
    if (launch.selection.kind === "selectable" && (wanted !== undefined ? wanted : await this.root.readSelection(provider)) !== launch.selection.name)
      throw new ExecutionAccountChanged("selection")
    if (launch.credential) {
      const capability = this.capabilities.get(provider)
      if (!capability || await capability.credentialRevision(launch.credential.name, launch.env) !== launch.credential.revision)
        throw new ExecutionAccountChanged("credentials")
    }
  }

  /**
   * What a session paused on a sign-out is measured against: the account a
   * launch would use now, and an opaque source-equality hint for deliberate
   * Resume. Principal equality is not renewed authentication: automatic
   * recovery uses the separately verified sign-in receipt and sequence.
   */
  async signInState(provider: string, account: string): Promise<{ selected: string; credential: string }> {
    const capability = this.capabilities.get(provider)
    const selected = (capability && await capabilitySelection(this.root, capability)) ?? "default"
    const revision = await capability?.credentialRevision(account, childProcessEnv(process.env)).catch(() => undefined)
    return { selected, credential: createHash("sha256").update(`mako-sign-in\0${provider}\0${revision ?? ""}`).digest("hex").slice(0, 24) }
  }

  /* ------------------------------------------------------------ limits */

  /**
   * Another account to switch to, when the one in use is near its plan
   * limit or the harness just refused a turn on it, and another of the
   * harness's accounts has room (`limitOffer`). Never switches the selection
   * by itself: an account is money, and money moves are the user's to make.
   * A Fin goes on under another account only by their switch in Settings ›
   * Fins, and only that Fin's launches (`launch`'s `account`). A harness
   * with one account is warned of its limit with nothing to switch to, read
   * for it at most `SOLE_ACCOUNT_READ_MS` apart, and once per limit window
   * (`firstWarning`). Offers near a limit come at most once an hour per
   * harness, since a nag repeated is a nag ignored; a refused turn always asks.
   */
  async limitOffer(harness: string, refused = false): Promise<AccountLimitOffer | null> {
    if (this.capabilities.get(harness)?.mode !== "selectable") return null
    if (!refused && Date.now() - (this.suggestedAt.get(harness) ?? 0) < SUGGEST_THROTTLE_MS) return null
    const accounts = (await this.harnessAccounts(harness)).filter((account) => !account.missing && !account.removing)
    const active = accounts.find((account) => account.active)
    if (!active || (refused && accounts.length < 2)) return null
    if (accounts.length < 2) {
      if (Date.now() - (this.soleReadAt.get(harness) ?? 0) < SOLE_ACCOUNT_READ_MS) return null
      this.soleReadAt.set(harness, Date.now())
    }
    // The account in use first: only one near its limit, or refused, is worth reading the others for.
    const usage = await this.usage.read(harness, active.name)
    if (!refused && (spentPercent(usage) ?? 0) < LIMIT_NEAR_PERCENT) return null
    const readings = []
    for (const account of accounts)
      readings.push({ ...account, usage: account === active ? usage : await this.usage.read(harness, account.name) })
    const offer = limitOffer(harness, readings, Date.now(), refused)
    if (offer && !refused) this.suggestedAt.set(harness, Date.now())
    if (offer && !refused && !offer.to && !await this.firstWarning(offer)) return null
    return offer
  }

  /**
   * Whether a warning with nothing to offer is the first for its account's limit window, kept on disk since another
   * host, or this one rebuilt, reads the same 96% and has nothing new to say. A reset that drifts between reads is the
   * same window; once it has passed the next is news.
   */
  private async firstWarning(offer: AccountLimitOffer): Promise<boolean> {
    const window = offer.from.window
    const key = `${offer.from.name}:${window?.windowMinutes ?? 0}:${window?.scope ?? ""}`
    const now = Date.now()
    const path = this.root.warned(offer.harness)
    const warned = Object.fromEntries(Object.entries(readWarned(await readOptionalFile(path).catch(() => null))).filter(([, until]) => until > now))
    if (warned[key] !== undefined) return false
    warned[key] = window?.resetsAt && window.resetsAt > now ? window.resetsAt : now + WARNED_UNREAD_RESET_MS
    try {
      await publishFile(path, JSON.stringify(warned))
    } catch (error) {
      hostWarn("accounts", "a limit's warning wasn't kept; it may come again", { harness: offer.harness, error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  /**
   * The harness's account in use when it's at its limit now, with when it resets and another of the harness's
   * accounts with room, or null: what a Fin's start reads before it runs there. A harness Mako reads no limits for,
   * or an account whose reading failed, reads as having room.
   */
  async limited(harness: string): Promise<HarnessLimit | null> {
    const accounts = (await this.harnessAccounts(harness)).filter((account) => !account.missing && !account.removing)
    const active = accounts.find((account) => account.active) ?? (accounts.length === 1 ? accounts[0] : undefined)
    if (!active) return null
    const now = Date.now()
    const usage = await this.usage.read(harness, active.name)
    const spent = spentUntil(usage, now)
    if (!spent) return null
    const readings = []
    for (const account of accounts)
      readings.push({ ...account, active: account === active, usage: account === active ? usage : await this.usage.read(harness, account.name) })
    const offer = accounts.length > 1 ? limitOffer(harness, readings, now, true) : null
    return { account: active.email ?? active.name, until: spent.until, ...(offer?.to && { instead: offer.to.email ?? offer.to.name }) }
  }

  /**
   * Each of the harness's accounts as a Fin's fallback order reads them (`fallbackOrder`), in the order Settings ›
   * Agents lists them: which is in use, which is at its limit and until when, and which can't be read or started on.
   * The account in use (or `on`) is read first and the others only when it is at its limit or `all` asks, so a start
   * with room reads one account. An account whose reading failed is unread, never taken as having room.
   */
  async standing(harness: string, on?: string, all = false): Promise<FallbackAccount[]> {
    const capability = this.capabilities.get(harness)
    if (!capability) return []
    const accounts = (await this.harnessAccounts(harness)).filter((account) => !account.missing)
    const active = accounts.find((account) => account.active) ?? (accounts.length === 1 ? accounts[0] : undefined)
    const from = accounts.find((account) => account.name === on) ?? active
    const now = Date.now()
    const first = from ? await this.usage.read(harness, from.name) : undefined
    const spent = from && spentUntil(first, now)
    const standing: FallbackAccount[] = []
    for (const account of accounts) {
      const usage = account === from ? first : spent || all ? await this.usage.read(harness, account.name) : undefined
      const limit = usage ? spentUntil(usage, now) : undefined
      standing.push({
        name: account.name,
        label: account.name === "default" ? account.email ?? account.name : account.name,
        active: account === active,
        ...(limit && { spent: limit }),
        ...(usage && usage.status !== "ok" && { unread: true as const }),
        ...((account.removing || account.signedOut || (capability.mode !== "selectable" && account !== active)) && { unusable: true as const }),
      })
    }
    return standing
  }

  /**
   * Re-reads, while a window is open, the account in use of each harness
   * whose login spends its limits where Mako can't see (`usedElsewhere`):
   * every `everyMs`, a fresh reading reused, and twice as long after each
   * failed read, up to an hour. One job checks them all each minute.
   */
  watchElsewhere(jobs: Pick<HostJobs, "every">, needs: readonly JobDemand[]): () => void {
    const due = new Map<string, { at: number; wait: number }>()
    return jobs.every("account-limits-elsewhere", ELSEWHERE_TICK_MS, async () => {
      for (const capability of this.capabilities.list()) {
        const elsewhere = capability.usedElsewhere
        const next = due.get(capability.provider)
        if (!elsewhere || (next && Date.now() < next.at)) continue
        const name = (await capabilitySelection(this.root, capability).catch(() => null)) ?? "default"
        const usage = await this.usage.readElsewhere(capability.provider, name, elsewhere.read)
        const wait = usage.status === "ok" ? elsewhere.everyMs : Math.min((next?.wait ?? elsewhere.everyMs) * 2, ELSEWHERE_BACKOFF_MS)
        due.set(capability.provider, { at: Date.now() + wait, wait })
      }
    }, { needs })
  }

  /** The same offer in a sentence, for a headless run's notice. */
  async switchSuggestion(harness: AccountHarness): Promise<string | null> {
    const offer = await this.limitOffer(harness)
    if (!offer?.to) return null
    const percent = (side: AccountLimitOffer["from"]) => `${Math.round(side.window?.usedPercent ?? 0)}%`
    return `${this.label(harness)} account ${offer.from.email ?? offer.from.name} is at ${percent(offer.from)} of its limit. ${offer.to.email ?? offer.to.name} is at ${percent(offer.to)}. Switch in Settings → Agents.`
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
    const selection = await capabilitySelection(this.root, capability).catch(() => null)
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
    const removing = await removingNames(this.root, capability.provider)
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
    const task = previous.catch(() => undefined).then(() => this.root.withMutation(provider, run))
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
      await rm(removalMarker(this.root, capability.provider, name), { force: true })
    }
  }

  /** Finish a pending removal once nothing holds the account; quiet when there is none. */
  private async completeRemoval(provider: string, name: string): Promise<void> {
    let event: AccountRemovalEvent | undefined
    try {
      event = await this.mutate(provider, async () => {
        const marker = removalMarker(this.root, provider, name)
        if (!existsSync(marker)) return undefined
        const capability = this.capabilities.get(provider)
        if (capability?.mode !== "selectable" || await this.held(provider, name)) return undefined
        // Selected meanwhile by a Mako that doesn't refuse it: that choice keeps it.
        if ((await this.root.readSelection(provider)) === name) {
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

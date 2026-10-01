import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { providers } from "@/state/providers"
import { confirmAction } from "@/state/confirm"
import { hasReset, nextReset } from "../../electron/contracts/account-usage"

/**
 * Provider accounts — several logins per CLI, switchable.
 *
 * The Orca mechanism: each captured account is an isolated config home
 * selected by env var at spawn, with everything except credentials symlinked
 * back to the real home, so skills and sessions stay identical across
 * accounts. Usage windows come from the providers' own endpoints; a bar
 * near full is the reason to switch.
 *
 * State rather than component state because several surfaces read it — the
 * rail's identity row and menu, Settings → Agents and Settings → Usage — and
 * because the identity menu opens often: the staleness guard keeps a curious
 * click from hammering the providers' usage endpoints.
 */

import type {
  AccountHarness,
  AccountProvider,
  AccountUsage,
  AccountProviderInfo,
  HarnessAccount,
} from "@/lib/types"
export type { AccountHarness, AccountProvider, AccountUsage } from "@/lib/types"
export type ProviderAccount = Omit<HarnessAccount, "dir">

export interface AccountGroup {
  provider: AccountProviderInfo
  /** In discovery order, so switching moves the check, not the rows. */
  accounts: ProviderAccount[]
}

interface AccountsState {
  providers: AccountProviderInfo[]
  accounts: ProviderAccount[]
  usage: Record<string, AccountUsage>
  /** `harness:name` of the account a switch/capture/remove is acting on. */
  busy?: string
  /** `harness:name` of the account spending a reset credit. */
  resetting?: string
  loadedAt?: number
}

const STALE_MS = 60_000

export const accountsStore = createStore<AccountsState>({
  providers: [],
  accounts: [],
  usage: {},
})
export const useAccounts = createHook(accountsStore)

export function usageKey(harness: AccountProvider, name: string): string {
  return `${harness}:${name}`
}

let grouped: {
  providers: AccountProviderInfo[]
  accounts: ProviderAccount[]
  groups: AccountGroup[]
} | undefined

/**
 * Accounts under the harness that spends them, in the host's provider order.
 * Harnesses with no login are left out: an empty group is a sign-in prompt,
 * and Settings → Agents is where those live.
 */
export function accountGroups(state: AccountsState): AccountGroup[] {
  if (grouped?.providers === state.providers && grouped.accounts === state.accounts)
    return grouped.groups
  const groups = state.providers
    .map((provider) => ({
      provider,
      accounts: state.accounts.filter(
        (account) => account.harness === provider.provider
      ),
    }))
    .filter((group) => group.accounts.length > 0)
  grouped = { providers: state.providers, accounts: state.accounts, groups }
  return groups
}

function setUsage(harness: AccountProvider, name: string, value: AccountUsage) {
  accountsStore.set((state) => ({
    usage: { ...state.usage, [usageKey(harness, name)]: value },
  }))
  scheduleResets()
}

function readUsage(account: ProviderAccount) {
  void getMako()
    .accountUsage(account.harness, account.name)
    .then((value) => setUsage(account.harness, account.name, value))
    .catch(() => {})
}

/** A reset's new reading may lag the reset itself by a moment at the provider. */
const RESET_GRACE_MS = 3_000
/** Timers far ahead are re-armed rather than trusted across sleep. */
const MAX_RESET_WAIT_MS = 60 * 60_000
let resetTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Read an account again the moment one of its windows resets, so a meter
 * at its limit empties when the room comes back rather than at the next
 * focus or turn. One timer, for the soonest reset on screen.
 */
function scheduleResets() {
  clearTimeout(resetTimer)
  const now = Date.now()
  const soonest = Math.min(
    ...Object.values(accountsStore.get().usage).map((usage) => nextReset(usage, now) ?? Infinity)
  )
  if (soonest === Infinity) return
  resetTimer = setTimeout(() => {
    const at = Date.now()
    const { accounts: listed, usage } = accountsStore.get()
    for (const account of listed)
      if (hasReset(usage[usageKey(account.harness, account.name)], at)) readUsage(account)
    scheduleResets()
  }, Math.min(soonest - now + RESET_GRACE_MS, MAX_RESET_WAIT_MS))
}

export const accounts = {
  /** Load the list and fan out usage reads; recent loads are reused. */
  load(force = false) {
    if (!hasBridge()) return
    const { loadedAt } = accountsStore.get()
    if (!force && loadedAt && Date.now() - loadedAt < STALE_MS) return
    accountsStore.set({ loadedAt: Date.now() })
    void getMako()
      .accounts()
      .then((catalog) => {
        accountsStore.set(catalog)
        for (const account of catalog.accounts) readUsage(account)
      })
      .catch((error) => {
        // Keep whatever list is already on screen — a transient refresh
        // failure must not blank two surfaces. Re-arm the staleness guard.
        accountsStore.set({ loadedAt: undefined })
        toast.error("Accounts could not be loaded", {
          duration: ACTION_TOAST_MS,
          description: error instanceof Error ? error.message : String(error),
          action: { label: "Retry", onClick: () => accounts.load(true) },
        })
      })
  },

  /** A live session reported its account's limits; no request needed. */
  observed(harness: AccountProvider, name: string, usage: AccountUsage) {
    if (accountsStore.get().loadedAt === undefined) return
    setUsage(harness, name, usage)
  },

  /**
   * A turn on `harness` ended: read the accounts it could have spent from
   * again. Only once something has asked for accounts, so a desk that never
   * opens them never polls providers for them.
   */
  spent(harness: AccountProvider) {
    if (!hasBridge() || accountsStore.get().loadedAt === undefined) return
    for (const account of accountsStore.get().accounts) {
      if (account.harness !== harness || !account.active) continue
      readUsage(account)
    }
  },

  async select(harness: AccountHarness, name: string) {
    const key = usageKey(harness, name)
    if (accountsStore.get().busy) return
    accountsStore.set({ busy: key })
    try {
      await getMako().selectAccount(harness, name === "default" ? null : name)
      accounts.load(true)
      await providers.refreshAccount(harness)
    } catch (error) {
      toast.error("Account was not switched", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
        action: {
          label: "Retry",
          onClick: () => void accounts.select(harness, name),
        },
      })
    } finally {
      accountsStore.set({ busy: undefined })
    }
  },

  /**
   * Spend a reset credit, after the user confirms. One attempt id per
   * confirmation: retrying a lost answer repeats it and spends nothing more.
   */
  async useReset(harness: AccountProvider, name: string, label: string, attempt?: string) {
    const key = usageKey(harness, name)
    if (accountsStore.get().resetting) return
    if (!attempt) {
      const confirmed = await confirmAction({
        title: "Use a reset credit?",
        body: `This empties every ${label} limit on this account now. The credit is spent and can't be given back.`,
        confirm: "Use reset",
      })
      if (!confirmed) return
    }
    const id = attempt ?? crypto.randomUUID()
    accountsStore.set({ resetting: key })
    try {
      const outcome = await getMako().useResetCredit(harness, name, id)
      if (outcome === "reset") toast.success(`${label} limits reset`, { duration: ACTION_TOAST_MS })
      else if (outcome === "nothing-to-reset")
        toast(`Nothing to reset`, { duration: ACTION_TOAST_MS, description: `${label} had no limit to empty, so the credit wasn't spent.` })
      else if (outcome === "no-credit")
        toast.error("No reset credits left", { duration: ACTION_TOAST_MS })
      else toast(`That reset was already used`, { duration: ACTION_TOAST_MS })
    } catch (error) {
      toast.error("The reset may not have gone through", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Try again", onClick: () => void accounts.useReset(harness, name, label, id) },
      })
    } finally {
      accountsStore.set({ resetting: undefined })
      const account = accountsStore.get().accounts.find((entry) => entry.harness === harness && entry.name === name)
      if (account) readUsage(account)
    }
  },

  async capture(harness: AccountHarness, name: string) {
    await getMako().captureAccount(harness, name)
    accounts.load(true)
  },

  async remove(harness: AccountHarness, name: string) {
    const key = usageKey(harness, name)
    if (accountsStore.get().busy) return
    accountsStore.set({ busy: key })
    try {
      await getMako().removeAccount(harness, name)
      accounts.load(true)
      await providers.refreshAccount(harness)
    } catch (error) {
      toast.error("Account was not removed", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
        action: {
          label: "Retry",
          onClick: () => void accounts.remove(harness, name),
        },
      })
    } finally {
      accountsStore.set({ busy: undefined })
    }
  },
}

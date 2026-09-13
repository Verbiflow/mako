import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { providers } from "@/state/providers"

/**
 * Provider accounts — several logins per CLI, switchable.
 *
 * The Orca mechanism: each captured account is an isolated config home
 * selected by env var at spawn, with everything except credentials symlinked
 * back to the real home, so skills and sessions stay identical across
 * accounts. Usage windows come from the providers' own endpoints; a bar
 * near full is the reason to switch.
 *
 * State rather than component state because two surfaces read it — the
 * settings section and the identity menu — and because the identity menu
 * opens often: the staleness guard keeps a curious click from hammering the
 * providers' usage endpoints.
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

interface AccountsState {
  providers: AccountProviderInfo[]
  accounts: ProviderAccount[]
  usage: Record<string, AccountUsage>
  /** `harness:name` of the account a switch/capture/remove is acting on. */
  busy?: string
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
        for (const account of catalog.accounts) {
          void getMako()
            .accountUsage(account.harness, account.name)
            .then((value) =>
              accountsStore.set((state) => ({
                usage: {
                  ...state.usage,
                  [usageKey(account.harness, account.name)]: value,
                },
              }))
            )
            .catch(() => {})
        }
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

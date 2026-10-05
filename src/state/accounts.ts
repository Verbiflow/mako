import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { providers } from "@/state/providers"
import { confirmAction } from "@/state/confirm"
import { desktop } from "@/state/desktop"
import { hasReset, nextReset } from "../../electron/contracts/account-usage"

/**
 * Provider accounts — several logins per CLI, switchable.
 *
 * Adding one is a sign-in the host runs: the provider's CLI opens the
 * browser into a new isolated profile and the account appears when it
 * finishes. One sign-in at a time, and its card is state here so Settings
 * and the identity menu agree on it. The host retains settings/store origins
 * and isolates credentials; this state presents declared controls without
 * provider-name switches. Usage windows come from the providers' own endpoints.
 *
 * State rather than component state because several surfaces read it — the
 * rail's identity row and menu, Settings → Agents and Settings → Usage — and
 * because the identity menu opens often: the staleness guard keeps a curious
 * click from hammering the providers' usage endpoints.
 */

import type {
  AccountHarness,
  AccountLogin,
  AccountLoginResult,
  AccountProvider,
  AccountRemoval,
  AccountRemovalEvent,
  AccountRemovalPlan,
  AccountUsage,
  AccountProviderInfo,
  HarnessAccount,
} from "@/lib/types"
import { accountIdentity } from "@/lib/account-identity"
import { removalConfirmation } from "@/lib/account-removal"
export type { AccountHarness, AccountProvider, AccountUsage } from "@/lib/types"
export type ProviderAccount = Omit<HarnessAccount, "dir">

/** What the window says after removing an account whose key its provider still accepts. */
export function removalNotice(label: string, stillValid: NonNullable<AccountRemoval["stillValid"]>) {
  const until = stillValid.expiresAt === undefined
    ? "until you revoke it"
    : `until ${new Date(stillValid.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })} unless you revoke it`
  return {
    title: `${label} still accepts this account's key`,
    description: `Mako removed the account, but ${stillValid.reason}. The key Mako made for it keeps working ${until}.`,
  }
}

export interface AccountGroup {
  provider: AccountProviderInfo
  /** In discovery order, so switching moves the check, not the rows. */
  accounts: ProviderAccount[]
}

/**
 * The account being added, or signed in again when `renew` names it:
 * opening the provider's sign-in, waiting on the browser, or why it stopped.
 */
/** Which sign-in: a new account for `harness`, or the one `renew` names signing in again. */
interface SignInTarget {
  harness: AccountHarness
  renew?: string
}

export type AccountSignIn =
  | (SignInTarget & { phase: "starting" })
  | (SignInTarget & { phase: "waiting"; login: AccountLogin; codeSent: boolean })
  | (SignInTarget & { phase: "failed"; message: string })

interface AccountsState {
  providers: AccountProviderInfo[]
  accounts: ProviderAccount[]
  usage: Record<string, AccountUsage>
  /** `harness:name` of the account a switch/remove is acting on. */
  busy?: string
  /** What `busy` is doing when it isn't switching: "Removing…". */
  busyText?: string
  /** `harness:name` of the account spending a reset credit. */
  resetting?: string
  signIn?: AccountSignIn
  /** `harness:name` of an account added a moment ago, so its row can say so. */
  added?: string
  /** `harness:name` of an account signed in again a moment ago. */
  renewed?: string
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

/** Whether the card on screen is still this sign-in's; a newer one or a cancel took it over otherwise. */
function ownsSignIn(id: string): boolean {
  const signIn = accountsStore.get().signIn
  return signIn?.phase === "waiting" && signIn.login.id === id
}

/** The "Added" toast offers choosing the account, which is stale once it was chosen anywhere. */
function addedToast(key: string): string {
  return `account-added:${key}`
}

export const accounts = {
  /** Load the list and fan out usage reads; recent loads are reused. */
  load(force = false) {
    if (!hasBridge()) return
    const { loadedAt } = accountsStore.get()
    if (!force && loadedAt && Date.now() - loadedAt < STALE_MS) return
    void accounts.reload()
  },

  /** Read the list now; resolves once it, or its failure, is on screen. */
  async reload() {
    accountsStore.set({ loadedAt: Date.now() })
    try {
      const catalog = await getMako().accounts()
      accountsStore.set(catalog)
      for (const account of catalog.accounts) readUsage(account)
    } catch (error) {
      // Keep whatever list is already on screen — a transient refresh
      // failure must not blank two surfaces. Re-arm the staleness guard.
      accountsStore.set({ loadedAt: undefined })
      toast.error("Accounts could not be loaded", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Retry", onClick: () => accounts.load(true) },
      })
    }
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
      toast.dismiss(addedToast(key))
      accounts.load(true)
      await providers.refreshAccount(harness)
      return true
    } catch (error) {
      toast.error("Account was not switched", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
        action: {
          label: "Retry",
          onClick: () => void accounts.select(harness, name),
        },
      })
      return false
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

  /**
   * Add an account, or sign the one `renew` names in again: the host starts
   * the provider's sign-in in the browser and this resolves when it
   * finishes, fails or is cancelled. Starting another replaces whichever
   * was waiting.
   */
  async signIn(harness: AccountHarness, renew?: string) {
    const current = accountsStore.get().signIn
    if (current?.phase === "starting") return
    if (current?.phase === "waiting") void getMako().cancelAccountLogin(current.login.id).catch(() => {})
    const started: SignInTarget = { harness }
    if (renew !== undefined) started.renew = renew
    accountsStore.set({ signIn: { ...started, phase: "starting" }, added: undefined, renewed: undefined })
    let login: AccountLogin
    try {
      login = await getMako().startAccountLogin(harness, renew)
    } catch (error) {
      if (accountsStore.get().signIn?.harness === harness)
        accountsStore.set({ signIn: { ...started, phase: "failed", message: error instanceof Error ? error.message : String(error) } })
      return
    }
    const now = accountsStore.get().signIn
    if (now?.harness !== harness || now.phase !== "starting") {
      // Cancelled while the sign-in was opening.
      void getMako().cancelAccountLogin(login.id).catch(() => {})
      return
    }
    accountsStore.set({ signIn: { ...started, phase: "waiting", login, codeSent: false } })
    if (login.openPage && login.url) void desktop.openUrl(login.url)
    let result: AccountLoginResult
    try {
      result = await getMako().waitAccountLogin(login.id)
    } catch (error) {
      if (ownsSignIn(login.id))
        accountsStore.set({ signIn: { ...started, phase: "failed", message: error instanceof Error ? error.message : String(error) } })
      return
    }
    if (!ownsSignIn(login.id)) return
    if (result.status === "cancelled") {
      accountsStore.set({ signIn: undefined })
      return
    }
    // The card gives way to the account's row only once the row shows the new
    // login; a reading from before it would still say signed out.
    const signedInKey = usageKey(harness, result.name)
    accountsStore.set((state) => {
      const usage = { ...state.usage }
      delete usage[signedInKey]
      return { usage }
    })
    await accounts.reload()
    if (!ownsSignIn(login.id)) return
    accountsStore.set({ signIn: undefined })
    void providers.refreshAccount(harness)
    if (result.status === "renewed") {
      accountsStore.set({ renewed: usageKey(harness, result.name) })
      if (result.previousEmail)
        toast(`Now signed in as ${result.email ?? "another account"}`, {
          duration: ACTION_TOAST_MS,
          description: `This login was ${result.previousEmail}. New sessions that use it run as ${result.email ?? "the new account"}.`,
        })
      else toast.success(`Signed in again${result.email ? ` as ${result.email}` : ""}`, { duration: ACTION_TOAST_MS })
      return
    }
    if (result.status === "duplicate") {
      const existing = accountsStore.get().accounts.find(
        (account) => account.harness === harness && account.name === result.name
      )
      const title = `${result.email ?? "That account"} is already added`
      const description = "Sign in with a different account to add another."
      if (existing && !existing.active)
        toast(title, {
          duration: ACTION_TOAST_MS,
          description,
          action: { label: "Use it", onClick: () => void accounts.select(harness, result.name) },
        })
      else toast(title, { description })
      return
    }
    accountsStore.set({ added: usageKey(harness, result.name) })
    toast.success(`Added ${result.email ?? "the account"}`, {
      id: addedToast(usageKey(harness, result.name)),
      duration: ACTION_TOAST_MS,
      description: "Use it now to switch every session; open ones follow with their next message.",
      action: { label: "Use it now", onClick: () => void accounts.select(harness, result.name) },
    })
  },

  /** Paste the code a sign-in page showed instead of returning to the app. */
  async submitSignInCode(code: string) {
    const signIn = accountsStore.get().signIn
    if (signIn?.phase !== "waiting") return false
    try {
      await getMako().submitAccountLoginCode(signIn.login.id, code)
    } catch (error) {
      toast.error("The code wasn't sent", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Try again", onClick: () => void accounts.submitSignInCode(code) },
      })
      return false
    }
    if (ownsSignIn(signIn.login.id)) accountsStore.set({ signIn: { ...signIn, codeSent: true } })
    return true
  },

  openSignInPage() {
    const signIn = accountsStore.get().signIn
    if (signIn?.phase === "waiting" && signIn.login.url) void desktop.openUrl(signIn.login.url)
  },

  /** For signing in from another browser or a private window, where a different account is signed in on the web. */
  async copySignInLink() {
    const signIn = accountsStore.get().signIn
    if (signIn?.phase !== "waiting" || !signIn.login.url) return
    try {
      await navigator.clipboard.writeText(signIn.login.url)
      toast("Sign-in link copied", {
        duration: ACTION_TOAST_MS,
        description: "Open it in the browser or private window where you'll sign in.",
      })
    } catch {
      toast.error("The link couldn't be copied", { duration: ACTION_TOAST_MS })
    }
  },

  /** Stop waiting; the host removes the half-made profile. */
  cancelSignIn() {
    const signIn = accountsStore.get().signIn
    accountsStore.set({ signIn: undefined })
    if (signIn?.phase === "waiting") void getMako().cancelAccountLogin(signIn.login.id).catch(() => {})
  },

  /**
   * Ask with every session on the account named and what happens to it,
   * then remove. Work still running keeps the account until it ends; the
   * host finishes the removal then and says so through `removal`.
   */
  async remove(harness: AccountHarness, name: string) {
    const key = usageKey(harness, name)
    if (accountsStore.get().busy) return
    const { label, identity, selected } = describe(harness, name)
    let plan: AccountRemovalPlan
    try {
      plan = await getMako().accountRemovalPlan(harness, name)
    } catch (error) {
      removalFailed(harness, name, error instanceof Error ? error.message : String(error))
      return
    }
    if (!await confirmAction(removalConfirmation(label, identity, selected, plan))) return
    accountsStore.set({ busy: key, busyText: "Removing…" })
    try {
      const outcome = await getMako().removeAccount(harness, name)
      accounts.load(true)
      await providers.refreshAccount(harness)
      if (outcome.status === "pending") removalPending(harness, name, identity)
      else removed(label, outcome)
    } catch (error) {
      removalFailed(harness, name, error instanceof Error ? error.message : String(error))
    } finally {
      accountsStore.set({ busy: undefined, busyText: undefined })
    }
  },

  /** Withdraw a removal that waits for work on the account. */
  async keep(harness: AccountHarness, name: string) {
    const key = usageKey(harness, name)
    if (accountsStore.get().busy) return
    accountsStore.set({ busy: key, busyText: "Keeping…" })
    try {
      if (!await getMako().keepAccount(harness, name))
        toast("It was already removed", { duration: ACTION_TOAST_MS })
      accounts.load(true)
    } catch (error) {
      toast.error("Account was not kept", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      accountsStore.set({ busy: undefined, busyText: undefined })
    }
  },

  /** A removal changed on the host: it began waiting, finished, failed or was withdrawn, maybe from another window. */
  removal(harness: AccountHarness, name: string, event: AccountRemovalEvent) {
    const { label, identity } = describe(harness, name)
    accounts.load(true)
    if (event.status === "removed") {
      void providers.refreshAccount(harness)
      toast(`Removed ${identity}`, { duration: ACTION_TOAST_MS, description: "The work using it has finished." })
      removed(label, event)
    } else if (event.status === "failed") removalFailed(harness, name, event.message)
  },
}

function describe(harness: AccountHarness, name: string) {
  const { accounts: listed, providers: known } = accountsStore.get()
  const account = listed.find((entry) => entry.harness === harness && entry.name === name)
  const selected = listed.find((entry) => entry.harness === harness && entry.active)
  return {
    label: known.find((entry) => entry.provider === harness)?.label ?? harness,
    identity: account?.email ?? "this account",
    selected: selected ? accountIdentity(selected) : "the selected account",
  }
}

function removed(label: string, removal: AccountRemoval) {
  const { stillValid } = removal
  if (!stillValid) return
  const notice = removalNotice(label, stillValid)
  toast.warning(notice.title, {
    duration: ACTION_TOAST_MS,
    description: notice.description,
    action: { label: "Open API keys", onClick: () => void desktop.openUrl(stillValid.manageUrl) },
  })
}

function removalPending(harness: AccountHarness, name: string, identity: string) {
  toast(`${identity} is removed when its work ends`, {
    duration: ACTION_TOAST_MS,
    description: "Sessions using it finish what they're doing first. Until then it can't be selected.",
    action: { label: "Keep it", onClick: () => void accounts.keep(harness, name) },
  })
}

function removalFailed(harness: AccountHarness, name: string, message: string) {
  toast.error("Account was not removed", {
    duration: ACTION_TOAST_MS,
    description: message,
    action: { label: "Retry", onClick: () => void accounts.remove(harness, name) },
  })
}

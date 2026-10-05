import type { AccountSwitchWait } from "./contracts/live-conversations.js"

/** Account discovery is registry-driven, so provider modules may add more ids. */
export type AccountHarness = string
export type AccountProvider = string
/** A native sign-in Mako is running into an isolated profile. Contains no credentials. */
export interface AccountLogin {
  id: string
  harness: AccountHarness
  /** The account being signed in again; absent when adding one. */
  renew?: string
  /** The provider's sign-in page. */
  url?: string
  /** Nobody has opened the page yet: the window opens it once. */
  openPage: boolean
  /**
   * What the person can paste back: the code the page shows, or the address
   * the browser ended on when it could not hand back to the CLI.
   */
  paste?: "code" | "address"
  /** The page hands back only through what is pasted, so pasting is the next step rather than a fallback. */
  pasteOnly?: true
}
/** How a sign-in ended. A failed one rejects with its reason instead. */
export type AccountLoginResult =
  | { status: "added"; name: string; email?: string }
  /** The login is one Mako already has, under `name`; nothing new was kept. */
  | { status: "duplicate"; name: string; email?: string }
  /** An existing account signed in again; `previousEmail` when it is now someone else. */
  | { status: "renewed"; name: string; email?: string; previousEmail?: string }
  | { status: "cancelled" }
export type OpenCodeAuthType = "oauth" | "api" | "wellknown"

export interface HarnessAccount {
  harness: AccountProvider
  name: string
  /** The login's actual identity — the email a human recognizes. */
  email?: string
  accountId?: string
  providerId?: string
  authType?: OpenCodeAuthType
  /** The isolated config home or credential file this account lives in. */
  dir: string
  active: boolean
  /**
   * Where the login came from: added in Mako, the CLI's own login that Mako
   * only reads, or one model provider's login (`providerId`) in a harness
   * that signs into several, such as OpenCode.
   */
  source?: "mako" | "cli" | "model-provider"
  /** Profile provenance, independent of the account's email or saved name. */
  route?: "native" | "managed"
  /** The plan as the provider names it, when discovery already knows it. */
  plan?: string
  /** A profile Mako keeps whose login is gone or expired; signing in again restores it. */
  signedOut?: true
  /** The selected account no longer exists; new sessions refuse until another is chosen. */
  missing?: true
  /** Removal waits for the work still running on it; it can't be selected meanwhile. */
  removing?: true
}

/** One limit an account spends against, as the provider reports it. */
export interface UsageWindow {
  usedPercent: number
  /** How long the window runs; `0` when the provider only gives its reset. */
  windowMinutes: number
  /** Unix ms when the window resets, when the provider says. */
  resetsAt: number | null
  /**
   * What the limit covers when the length alone doesn't say: "Opus" for
   * Claude's weekly Opus cap, "Auto" for Cursor's Auto-model share.
   */
  scope?: string
}

/** Money or credits an account can spend past its windows. */
export interface UsageBalance {
  /** What the balance is: "Extra usage", "Credits", "Promotional credit". */
  label: string
  remaining: number
  /** The starting amount, when the provider reports one. */
  total?: number
  unit: "usd" | "credits"
}

/** Early resets the provider granted, each spendable to empty the account's windows. */
export interface UsageResetCredits {
  available: number
  /** Unix ms the soonest available one expires. */
  expiresAt: number | null
}

/** What spending a reset credit did; `attempt` makes a repeated request spend at most one. */
export type ResetCreditOutcome = "reset" | "nothing-to-reset" | "no-credit" | "already-used"

export type AccountUsage =
  | {
      status: "ok"
      plan?: string
      /** Shortest window first; empty when the plan reports no limits. */
      windows: UsageWindow[]
      balances?: UsageBalance[]
      resetCredits?: UsageResetCredits
      /** Unix ms the provider gave this reading; older than now when a refresh failed. */
      readAt?: number
      detail?: string
    }
  | {
      status: "stale-token" | "missing-credentials" | "unavailable" | "error"
      plan?: string
      detail?: string
    }

export interface SelectedAccount {
  name: string
  dir?: string
}

/** What removing an account left at its provider. */
export interface AccountRemoval {
  /** A key Mako minted that the provider still accepts, because revoking it failed. */
  stillValid?: {
    /** Why, worded to follow "but": "Cursor couldn't be reached (…)". */
    reason: string
    /** ISO time the key lapses on its own. */
    expiresAt?: string
    /** Where the person can revoke it themselves. */
    manageUrl: string
  }
}

/**
 * What Remove did. Work still running on the account keeps its credentials:
 * removal is then pending and finishes by itself when that work ends.
 */
export type AccountRemovalOutcome =
  | ({ status: "removed" } & AccountRemoval)
  | { status: "pending" }

/** Every step of a removal, as the host reports it to windows. */
export type AccountRemovalEvent =
  | AccountRemovalOutcome
  | { status: "failed"; message: string }
  | { status: "kept" }

/**
 * What a session on the account waits for before it lets go of it, or
 * `close` for a harness that can't reopen a session and keeps the process
 * until the session is closed. Absent when it is idle and lets go now.
 */
export type AccountRemovalWait = AccountSwitchWait | "close"

export interface AccountRemovalSession {
  conversation: string
  title: string
  waitingFor?: AccountRemovalWait
}

/** Who still uses an account, read before asking to remove it. */
export interface AccountRemovalPlan {
  sessions: AccountRemovalSession[]
  /** Runs outside a session in this Mako, such as a headless turn or a title. */
  runs: number
  /** Another copy of Mako on this Mac runs work on it. */
  elsewhere: boolean
}

/** Public account controls contributed by the provider, without credential data. */
export interface AccountProviderInfo {
  provider: string
  label: string
  mode: "selectable" | "observed"
  loginCommand: string
  /** Accounts can be added and signed in again inside Mako. */
  nativeLogin?: true
  /** Why accounts can't be added in Mako, said once beside the provider's login. */
  readOnlyReason?: string
}

export interface AccountCatalog {
  providers: AccountProviderInfo[]
  accounts: HarnessAccount[]
}

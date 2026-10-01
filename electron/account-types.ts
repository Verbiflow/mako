/** Account discovery is registry-driven, so provider modules may add more ids. */
export type AccountHarness = string
export type AccountProvider = string
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
   * Where the login came from: captured here, found in a provider config, or
   * the CLI's own single login that Mako only reads.
   */
  source?: "mako" | "subrouter" | "opencode" | "cli"
  /** The plan as the provider names it, when discovery already knows it. */
  plan?: string
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

/** Public account controls contributed by the provider, without credential data. */
export interface AccountProviderInfo {
  provider: string
  label: string
  mode: "selectable" | "observed"
  loginCommand: string
}

export interface AccountCatalog {
  providers: AccountProviderInfo[]
  accounts: HarnessAccount[]
}

import type {
  AccountRemoval,
  AccountUsage,
  AccountProviderInfo,
  HarnessAccount,
  ResetCreditOutcome,
  SelectedAccount,
} from "../account-types.js"
import type { ProviderCapability } from "./registry.js"

interface AccountCapabilityBase
  extends
    ProviderCapability,
    Pick<AccountProviderInfo, "label" | "loginCommand" | "readOnlyReason"> {
  /** Discover only public account metadata; credentials never cross this boundary. */
  listAccounts(selection: string | null): Promise<HarnessAccount[]>
  /** Apply provider-owned credential isolation to a fresh environment copy. */
  accountEnv(
    selection: string | null,
    base: NodeJS.ProcessEnv
  ): Promise<NodeJS.ProcessEnv>
  selectedAccount(
    selection: string | null,
    env: NodeJS.ProcessEnv
  ): SelectedAccount
  /** Read the effective credential source on demand. Opaque host-only equality, never IPC. */
  credentialRevision(name: string, env?: NodeJS.ProcessEnv): Promise<string>
  accountUsage(name: string): Promise<AccountUsage>
  /**
   * Spend one of the account's reset credits to empty its windows. The same
   * `attempt` repeated after a lost answer spends nothing more.
   */
  useResetCredit?(name: string, attempt: string): Promise<ResetCreditOutcome>
}

interface SelectableAccounts extends AccountCapabilityBase {
  mode: "selectable"
  /** Copy the CLI's current login into a named profile. Adapters whose logins refresh in place leave this out. */
  captureAccount?(name: string): Promise<void>
  /** Forget the profile here; a key Mako minted for it is revoked at the provider first. */
  removeAccount(name: string): Promise<AccountRemoval>
}

/** What the person can paste back into a running sign-in. */
export type AccountLoginPaste = "code" | "address"

/**
 * Host-only: the native command that signs one profile in. The host runs it,
 * relays its sign-in page, any code the page asks for and anything pasted
 * back; the environment never crosses IPC.
 */
export interface AccountLoginCommand {
  kind: "command"
  executable: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  /** Exits 0 once the profile is signed in. Without it the adapter's `confirmAccountLogin` decides. */
  statusArgs?: readonly string[]
  /** The CLI reads the code its page shows, or the address the browser ended on, from its input. */
  paste?: AccountLoginPaste
  /** The page never hands back to the CLI by itself; what is pasted is the only way back. */
  pasteOnly?: true
  /** The CLI only asks through a terminal; the host gives it one. */
  terminal?: true
  /** The CLI prints its page without opening it, so the host opens it. */
  opensBrowser?: false
  /** Output meaning the pasted code was refused; the sign-in ends with that said. */
  refusedCode?: RegExp
}

/** A sign-in the adapter drives itself, such as an SDK's browser flow. Resolves once the profile is signed in. */
export interface AccountLoginTask {
  kind: "task"
  run(events: { page(url: string): void }, signal: AbortSignal): Promise<void>
}

export type AccountLoginLaunch = AccountLoginCommand | AccountLoginTask

/** Where a sign-in goes: a new empty profile, or an existing one whose login expired. */
export interface AccountLoginTarget {
  name: string
  renew: boolean
}

interface NativeLogin {
  nativeLogin: true
  prepareAccountLogin(target: AccountLoginTarget): Promise<AccountLoginLaunch>
  /**
   * Prove the sign-in landed and make it the profile's: a command without
   * `statusArgs` relies on this, and a renewal staged beside the profile is
   * moved into place here. Throws while it has not landed yet.
   */
  confirmAccountLogin?(target: AccountLoginTarget): Promise<void>
  /** Remove what a sign-in that will not finish staged. A new profile is removed by the host. */
  abandonAccountLogin?(target: AccountLoginTarget): Promise<void>
}

export type SelectableAccountCapability = SelectableAccounts & (
  | NativeLogin
  | { nativeLogin?: never; prepareAccountLogin?: never; confirmAccountLogin?: never; abandonAccountLogin?: never }
)

export interface ObservedAccountCapability extends AccountCapabilityBase {
  mode: "observed"
}

/**
 * An independent provider capability, rather than optional account fields on
 * another transport. Providers either register this complete contract or use
 * the host's default account/environment behavior.
 */
export type ProviderAccountCapability =
  SelectableAccountCapability | ObservedAccountCapability

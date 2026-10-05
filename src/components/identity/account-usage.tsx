import { useEffect, useState, type ReactNode } from "react"
import { CheckIcon, RotateCcwIcon } from "lucide-react"
import { Action, Chip, Meter } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Shimmer } from "@/components/ui/shimmer"
import { Skeleton } from "@/components/ui/skeleton"
import {
  accounts as accountActions,
  accountGroups,
  useAccounts,
  usageKey,
  type AccountGroup,
  type ProviderAccount,
} from "@/state/accounts"
import type { AccountUsage, UsageWindow } from "@/lib/types"
import { accountIdentity, authName, isSignedOut, providerName } from "@/lib/account-identity"
import { bindingWindow, windowsAt } from "../../../electron/contracts/account-usage"
import {
  balanceText,
  planText,
  readingAgeText,
  resetCreditsText,
  resetText,
  usageTone,
  usageWindowName,
  usageWindowShortName,
} from "@/lib/usage-window"
import { cn } from "@/lib/utils"

/**
 * Plan limits for every account Mako can see, grouped by the harness that
 * spends them. The identity menu and Settings render the same rows at two
 * densities, so a limit reads the same wherever it is checked.
 *
 * Every window is one line in fixed columns — name, bar, used, reset — so
 * bars line up across accounts and a harness with one window does not draw a
 * wider bar than one with three.
 */

type Density = "menu" | "page"

/** Reset times are relative; re-render on the minute so they stay true. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function AccountLimits({ density }: { density: Density }) {
  const groups = useAccounts(accountGroups)
  const loaded = useAccounts((state) => state.loadedAt !== undefined)
  if (groups.length === 0)
    return loaded ? (
      <p className="px-2 py-2 text-label text-faint">
        Sign in to an agent to see its plan limits here.
      </p>
    ) : (
      <div className="flex flex-col gap-2 px-2 py-2" aria-hidden>
        <Skeleton className="h-3.5 w-24 rounded" />
        <Skeleton className="h-1 w-full rounded-full" />
      </div>
    )
  if (density === "menu")
    return (
      <div className="flex flex-col divide-y divide-hairline">
        {groups.map((group) => (
          <MenuHarness key={group.provider.provider} group={group} />
        ))}
      </div>
    )
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <HarnessAccounts key={group.provider.provider} group={group} />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/** One harness's logins as a single recessed list, one divided row each. */
export function HarnessAccounts({
  group,
  heading = true,
  actions,
}: {
  group: AccountGroup
  /** Off where the surrounding row already names the harness. */
  heading?: boolean
  /** Per-account controls a surface adds, such as removing a saved login. */
  actions?: (account: ProviderAccount) => ReactNode
}) {
  const { provider, accounts } = group
  const switchable = provider.mode === "selectable" && accounts.length > 1
  return (
    <section aria-label={`${provider.label} accounts`} className="flex flex-col gap-2">
      {heading ? (
        <h3 className="flex items-center gap-2 text-label font-medium text-muted-foreground">
          <HarnessIcon harness={provider.provider} className="size-3.5" />
          {provider.label}
          {accounts.length > 1 ? (
            <span className="font-normal text-faint">{accounts.length} accounts</span>
          ) : null}
        </h3>
      ) : null}
      <div className={LIST}>
        {accounts.map((account) => (
          <PageAccount
            key={account.name}
            account={account}
            label={provider.label}
            switchable={switchable}
            renewable={provider.nativeLogin === true}
            actions={actions?.(account)}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * The recessed list Settings groups rows in. The hairline is drawn above the
 * rows so a hovered row's fill cannot cover the edge.
 */
const LIST =
  "relative overflow-hidden rounded-lg bg-shell/55 divide-y divide-hairline " +
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] " +
  "after:[box-shadow:inset_0_0_0_0.5px_var(--hairline)]"

/**
 * One login. With several to choose from the row is a radio: the whole row
 * picks it, the ring says which is in use. A row's own action (removing a
 * saved login) takes the plan's place while the row is pointed at, so a
 * list of logins does not read as a list of delete buttons.
 */
function PageAccount({
  account,
  label,
  switchable,
  renewable,
  actions,
}: {
  account: ProviderAccount
  label: string
  switchable: boolean
  /** The provider can sign this account in again from here. */
  renewable: boolean
  actions?: ReactNode
}) {
  const key = usageKey(account.harness, account.name)
  const usage = useAccounts((state) => state.usage[key])
  const busy = useAccounts((state) => state.busy)
  const added = useAccounts((state) => state.added === key)
  const renewed = useAccounts((state) => state.renewed === key)
  const renewing = useAccounts((state) =>
    state.signIn !== undefined && state.signIn.phase !== "failed" &&
    state.signIn.harness === account.harness && state.signIn.renew === account.name
  )
  const signedOut = isSignedOut(account, usage)
  const plan = signedOut ? undefined : (usage?.plan ?? account.plan)
  const detail = accountDetail(account, "page", label)
  const choosable = switchable && !account.active
  const heading = (
    <span className="flex min-w-0 items-start gap-3">
      {switchable ? <ChoiceMark active={account.active} /> : null}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate text-ui", account.missing ? "text-muted-foreground" : "text-foreground")}>
            {accountIdentity(account)}
          </span>
          {added || (renewed && !signedOut) ? (
            <Chip tone="positive" className="shrink-0 animate-enter">{added ? "New" : "Signed in"}</Chip>
          ) : signedOut ? (
            <Chip tone="caution" className="shrink-0">Signed out</Chip>
          ) : null}
        </span>
        {detail ? (
          <span className={cn("block truncate text-label", account.missing ? "text-caution" : "text-faint")}>{detail}</span>
        ) : null}
      </span>
      <span
        className={cn(
          "flex h-5 shrink-0 items-center gap-2 text-label text-faint",
          actions && "transition-opacity duration-100 group-focus-within/account:opacity-0 group-hover/account:opacity-0"
        )}
      >
        {busy === key ? (
          <Shimmer text="Switching…" />
        ) : renewing ? (
          <Shimmer text="Signing in…" />
        ) : switchable && account.active && !account.missing ? (
          <span className="text-muted-foreground">In use</span>
        ) : null}
        {plan ? planText(plan) : null}
      </span>
    </span>
  )
  return (
    <div
      className={cn(
        "group/account relative px-4 py-3",
        added && "animate-enter",
        account.missing && "bg-caution/5",
        choosable &&
          "transition-colors duration-100 hover:bg-fill-hover has-[>button:active:not(:disabled)]:bg-fill-selected",
        busy && busy !== key && "opacity-60"
      )}
    >
      {switchable ? (
        <SwitchButton account={account} label={label} disabled={Boolean(busy)}>
          {heading}
        </SwitchButton>
      ) : (
        heading
      )}
      {actions ? (
        <span className="absolute top-2.5 right-3 z-10 flex items-center opacity-0 transition-opacity duration-100 group-focus-within/account:opacity-100 group-hover/account:opacity-100">
          {actions}
        </span>
      ) : null}
      {account.missing || (renewing && signedOut) ? null : signedOut && renewable && account.source === "mako" ? (
        <div className={cn("mt-2.5 flex items-center gap-3", switchable && "pl-7")}>
          <span className="min-w-0 flex-1 text-label leading-snug text-faint">
            This {label} login expired or was signed out.
          </span>
          <Action
            size="xs"
            tone="outline"
            disabled={Boolean(busy)}
            onClick={() => void accountActions.signIn(account.harness, account.name)}
            className="relative z-10"
          >
            Sign in again
          </Action>
        </div>
      ) : (
        <div className={cn(switchable && "pl-7")}>
          <UsageLines usage={usage} label={label} density="page" className="mt-3" />
          <Footer usage={usage} account={account} label={label} density="page" className="mt-2.5" />
        </div>
      )}
    </div>
  )
}

/** A radio's ring, drawn rather than native so it sits on the row's text line. */
function ChoiceMark({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
        "[transition:box-shadow_120ms_ease]",
        active
          ? "ring-foreground/80"
          : "ring-foreground/20 group-hover/account:ring-foreground/45"
      )}
    >
      <span
        className={cn(
          "size-2 rounded-full bg-foreground [transition:transform_160ms_var(--ease-out),opacity_120ms_ease]",
          active ? "scale-100 opacity-100" : "scale-50 opacity-0"
        )}
      />
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Identity menu                                                       */
/* ------------------------------------------------------------------ */

/**
 * One harness in the menu. A single login sits under the harness's own
 * name; with several, the one in use shows its limits and the rest are one
 * line each — the window closest to its limit — and pressing one switches.
 */
function MenuHarness({ group }: { group: AccountGroup }) {
  const { provider, accounts } = group
  const switchable = provider.mode === "selectable" && accounts.length > 1
  const sole = accounts.length === 1 ? accounts[0] : undefined
  const soleUsage = useAccounts((state) =>
    sole ? state.usage[usageKey(sole.harness, sole.name)] : undefined
  )
  const solePlan = sole ? (soleUsage?.plan ?? sole.plan) : undefined
  return (
    <section aria-label={`${provider.label} accounts`} className="py-2 first:pt-1 last:pb-1">
      <h3 className="flex h-6 min-w-0 items-center gap-2 px-2 text-label">
        <HarnessIcon harness={provider.provider} className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium text-foreground/85">{provider.label}</span>
        <span className="min-w-0 flex-1 truncate text-faint">
          {sole ? accountIdentity(sole) : `${accounts.length} accounts`}
        </span>
        {solePlan ? <span className="shrink-0 text-faint">{planText(solePlan)}</span> : null}
      </h3>
      {sole ? (
        <div className="px-2">
          <UsageLines usage={soleUsage} label={provider.label} density="menu" className="mt-1" />
          <Footer usage={soleUsage} account={sole} label={provider.label} density="menu" className="mt-1" />
        </div>
      ) : (
        <div className="mt-0.5 flex flex-col gap-px">
          {accounts.map((account) =>
            switchable && !account.active ? (
              <MenuChoice key={account.name} account={account} label={provider.label} />
            ) : (
              <MenuAccount
                key={account.name}
                account={account}
                label={provider.label}
                switchable={switchable}
              />
            )
          )}
        </div>
      )}
    </section>
  )
}

/** The login in use, or one of several a harness reads at once. */
function MenuAccount({
  account,
  label,
  switchable,
}: {
  account: ProviderAccount
  label: string
  switchable: boolean
}) {
  const key = usageKey(account.harness, account.name)
  const usage = useAccounts((state) => state.usage[key])
  const busy = useAccounts((state) => state.busy)
  const plan = usage?.plan ?? account.plan
  const detail = accountDetail(account, "menu", label)
  const heading = (
    <span className="flex h-6 min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-ui text-foreground">
        {accountIdentity(account)}
        {detail ? <span className="text-label text-faint"> · {detail}</span> : null}
      </span>
      {plan ? <span className="shrink-0 text-label text-faint">{planText(plan)}</span> : null}
      {switchable ? <SwitchMark account={account} busy={busy === key} /> : null}
    </span>
  )
  return (
    <div className="relative px-2 py-0.5">
      {switchable ? (
        <SwitchButton account={account} label={label} disabled={Boolean(busy)}>
          {heading}
        </SwitchButton>
      ) : (
        heading
      )}
      <UsageLines usage={usage} label={label} density="menu" className="mt-0.5" />
      <Footer usage={usage} account={account} label={label} density="menu" className="mt-1" />
    </div>
  )
}

/** Another login of the harness: who, and how close it is to a limit. */
function MenuChoice({ account, label }: { account: ProviderAccount; label: string }) {
  const key = usageKey(account.harness, account.name)
  const usage = useAccounts((state) => state.usage[key])
  const busy = useAccounts((state) => state.busy)
  const now = useMinuteClock()
  const window = usage?.status === "ok" ? bindingWindow(windowsAt(usage.windows, now)) : undefined
  return (
    <div
      className={cn(
        "relative flex h-7 items-center gap-3 rounded-md px-2 transition-colors duration-100 hover:bg-fill-hover has-[>button:active:not(:disabled)]:bg-fill-selected",
        busy && busy !== key && "opacity-60"
      )}
    >
      <SwitchButton account={account} label={label} disabled={Boolean(busy)} className="min-w-0 flex-1">
        <span className="block truncate text-ui text-foreground/75">
          {busy === key ? <Shimmer text="Switching…" /> : accountIdentity(account)}
        </span>
      </SwitchButton>
      <span
        className="shrink-0 text-label text-faint tabular"
        title={usage && usage.status !== "ok" ? statusText(usage, label) : undefined}
      >
        {window ? (
          <>
            {usageWindowShortName(window)}{" "}
            <span className={TONE_TEXT[usageTone(window.usedPercent)]}>
              {percentUsed(window.usedPercent)}
            </span>
          </>
        ) : usage ? (
          shortStatus(usage)
        ) : null}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

function SwitchButton({
  account,
  label,
  disabled,
  className,
  children,
}: {
  account: ProviderAccount
  label: string
  disabled: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={account.active}
      disabled={disabled}
      title={
        account.active
          ? `Every ${label} session uses this account`
          : `Switch every ${label} session to ${accountIdentity(account)}`
      }
      onClick={() => {
        if (!account.active) void accountActions.select(account.harness, account.name)
      }}
      // The press covers the whole row; actions in the row sit above it.
      className={cn(
        "block w-full text-left after:absolute after:inset-0 after:rounded-[inherit] disabled:cursor-default",
        className
      )}
    >
      {children}
    </button>
  )
}

function SwitchMark({ account, busy }: { account: ProviderAccount; busy: boolean }) {
  if (busy) return <Shimmer text="Switching…" className="text-label" />
  return account.active ? (
    <CheckIcon className="size-3.5 text-foreground" aria-label="In use" />
  ) : (
    <span className="size-3.5" />
  )
}

const TONE_TEXT = {
  neutral: "text-foreground/80",
  caution: "text-caution",
  negative: "text-negative",
} as const

function percentUsed(percent: number): string {
  return `${Math.round(Math.min(100, Math.max(0, percent)))}% used`
}

export function UsageLines({
  usage,
  label,
  density,
  className,
}: {
  usage: AccountUsage | undefined
  label: string
  density: Density
  className?: string
}) {
  const now = useMinuteClock()
  if (!usage)
    return (
      <span className={cn("flex h-5 items-center gap-3", className)} aria-label="Loading usage">
        <Skeleton className={cn("h-3 rounded", density === "page" ? "w-32" : "w-13")} />
        <Skeleton className="h-1 flex-1 rounded-full" />
      </span>
    )
  if (usage.status !== "ok")
    return (
      <span
        className={cn("block text-label text-faint", className)}
        title={usage.status === "error" ? usage.detail : undefined}
      >
        {statusText(usage, label)}
      </span>
    )
  if (usage.windows.length === 0)
    return (
      <span className={cn("block text-label text-faint", className)}>
        No usage limits reported for this plan
      </span>
    )
  return (
    <span className={cn("flex flex-col", className)}>
      {usage.windows.map((window) => (
        <WindowLine
          key={`${window.windowMinutes}:${window.scope ?? ""}`}
          window={window}
          now={now}
          density={density}
        />
      ))}
    </span>
  )
}

function WindowLine({
  window,
  now,
  density,
}: {
  window: UsageWindow
  now: number
  density: Density
}) {
  const name = usageWindowName(window)
  // Past its reset the window is empty, whatever it read; a new reading follows.
  const reset = window.resetsAt !== null && window.resetsAt <= now
  const percent = reset ? 0 : window.usedPercent
  const used = percentUsed(percent)
  const resets = reset ? "just reset" : resetText(window.resetsAt, now)
  const tone = usageTone(percent)
  return (
    <span
      role="meter"
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(100, Math.max(0, percent)))}
      aria-valuetext={resets ? `${used}, ${resets}` : used}
      title={resets ? `${name}: ${used}, ${resets}` : `${name}: ${used}`}
      className="flex h-6 items-center gap-3 text-label"
    >
      <span
        className={cn(
          "shrink-0 truncate text-muted-foreground",
          density === "page" ? "w-32" : "w-13"
        )}
      >
        {density === "page" ? name : usageWindowShortName(window)}
      </span>
      <Meter value={percent / 100} tone={tone} className="h-1 min-w-8 flex-1 bg-fill-selected" />
      <span className={cn("tabular w-16 shrink-0 text-right", TONE_TEXT[tone])}>{used}</span>
      <span
        className={cn(
          "tabular shrink-0 truncate text-right text-faint",
          density === "page" ? "w-30" : "w-28"
        )}
      >
        {resets}
      </span>
    </span>
  )
}

/** Balances, reset credits and a kept reading's age, then the row's actions. */
function Footer({
  usage,
  account,
  label,
  density,
  actions,
  className,
}: {
  usage: AccountUsage | undefined
  account: ProviderAccount
  label: string
  density: Density
  actions?: ReactNode
  className?: string
}) {
  const now = useMinuteClock()
  const credits = usage?.status === "ok" ? usage.resetCredits : undefined
  const notes =
    usage?.status === "ok"
      ? [
          ...(usage.balances ?? []).map(balanceText),
          ...(credits
            ? [density === "menu" ? resetCreditsText({ ...credits, expiresAt: null }) : resetCreditsText(credits)]
            : []),
          readingAgeText(usage.readAt, now),
        ].filter((note) => note !== null)
      : []
  const reset = offersReset(usage, now)
  if (notes.length === 0 && !reset && !actions) return null
  return (
    <div className={cn("flex min-h-6 items-center gap-3", className)}>
      <span
        className="min-w-0 flex-1 text-label leading-snug text-faint"
        title={credits ? resetCreditsText(credits) : undefined}
      >
        {notes.join(" · ")}
      </span>
      {reset || actions ? (
        <span className="relative z-10 flex shrink-0 items-center gap-1">
          {reset ? <ResetCreditAction account={account} label={label} /> : null}
          {actions}
        </span>
      ) : null}
    </div>
  )
}

/** Worth spending a reset on: a window is nearly out and credits remain. */
function offersReset(usage: AccountUsage | undefined, now: number): boolean {
  return usage?.status === "ok" && (usage.resetCredits?.available ?? 0) > 0 &&
    (bindingWindow(windowsAt(usage.windows, now))?.usedPercent ?? 0) >= 90
}

function ResetCreditAction({ account, label }: { account: ProviderAccount; label: string }) {
  const key = usageKey(account.harness, account.name)
  const resetting = useAccounts((state) => state.resetting === key)
  const other = useAccounts((state) => Boolean(state.resetting) && state.resetting !== key)
  return (
    <Action
      size="xs"
      tone="outline"
      disabled={resetting || other}
      onClick={() => void accountActions.useReset(account.harness, account.name, label)}
      className="text-label"
    >
      <RotateCcwIcon className="text-faint" aria-hidden />
      {resetting ? <Shimmer text="Resetting…" /> : "Use a reset credit"}
    </Action>
  )
}

function statusText(usage: AccountUsage, label: string): string {
  if (usage.status === "stale-token")
    return usage.detail ?? `Usage appears the next time ${label} runs`
  if (usage.status === "missing-credentials")
    return "Signed out — sign in to see usage"
  if (usage.status === "unavailable")
    return usage.detail ?? "Usage isn't available for this login"
  return "Couldn't read usage. It retries in a minute."
}

/** The same states in the few words a one-line row has room for. */
function shortStatus(usage: AccountUsage): string {
  if (usage.status === "stale-token") return "Reads after its next run"
  if (usage.status === "missing-credentials") return "Signed out"
  if (usage.status === "unavailable") return "No limits for this login"
  if (usage.status === "error") return "Couldn't read usage"
  return "No limits reported"
}

/**
 * A second line saying where a login comes from, in the words a person
 * would use: the one their terminal uses, or one added here.
 */
function accountDetail(account: ProviderAccount, density: Density, label: string): string | null {
  if (account.missing)
    return density === "menu" ? "choose another" : `New ${label} sessions won't start until you choose another account`
  if (account.source === "opencode")
    return account.email
      ? `${providerName(account.providerId ?? account.name)} ${authName(account.authType)}`
      : null
  if (density === "menu") return null
  if (account.name === "default")
    return account.route ? "Same login as your terminal" : `${label}’s own login`
  if (account.source === "mako") return "Added in Mako"
  return null
}

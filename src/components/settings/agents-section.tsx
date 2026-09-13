import { useEffect, useState } from "react"
import { accounts as accountActions, useAccounts } from "@/state/accounts"
import {
  Action,
  Eyebrow,
  ListCard,
  ListCardRow,
  Segmented,
  SettingRow,
} from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { HARNESS_LABEL } from "@/components/rail/harness-meta"
import { setPref, usePrefs } from "@/state/prefs"
import { providers, useProviders } from "@/state/providers"
import { cn } from "@/lib/utils"
import { formatBytes, formatRelative } from "@/lib/format"
import { usageWindowLabel } from "@/lib/usage-window"
import { CheckIcon, RefreshCwIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"

/**
 * The harnesses this machine can host, and the accounts that need keys.
 *
 * Provider rows report the native control transport Mako found on this
 * machine. Claude and Codex can route through several isolated account homes.
 */
export function AgentsSection() {
  const conversionMode = usePrefs((prefs) => prefs.conversionMode)
  const profiles = useProviders((state) => state.profiles)
  const availability = useProviders((state) => state.availability)
  const daemon = useProviders((state) => state.daemon)
  const loginStart = useProviders((state) => state.daemonLogin)
  const harnesses = Object.keys(availability ?? HARNESS_LABEL).map((id) => ({
    id,
    name: profiles[id]?.label ?? HARNESS_LABEL[id] ?? id,
    how: profiles[id]?.transport === "remote" ? "Remote agent" : "Local agent",
  }))

  useEffect(() => {
    void Promise.all([providers.loadStatus(), providers.loadAll()])
  }, [])

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        title="Moving conversations"
        description="Transcript replay gives the next agent a deterministic newest-first bundle with reasoning, tool calls, and complete captured outputs. Session import writes a lossy copy into the target store."
      >
        <Segmented<"native" | "transcript">
          value={conversionMode}
          options={[
            { value: "transcript", label: "Transcript replay" },
            { value: "native", label: "Session import" },
          ]}
          onChange={(next) => setPref("conversionMode", next)}
        />
      </SettingRow>
      <p className="pb-3 text-ui leading-relaxed text-muted-foreground">
        Mako uses the provider apps already installed on this machine. Their
        model and reasoning settings are copied once as a sensible starting
        point; after that, choices made in Mako stay in Mako.
      </p>
      <p className="mb-3 flex items-center gap-1.5 rounded-md bg-surface px-2.5 py-1.5 text-label text-faint">
        <span
          className={cn(
            "size-1.5 rounded-full",
            daemon ? "bg-added" : "bg-faint/50"
          )}
        />
        <span className="min-w-0 flex-1">
          {daemon
            ? `Sync daemon running — ${daemon.sessions} sessions watched · ${daemon.rss === undefined ? "memory unavailable" : `${formatBytes(daemon.rss)} RSS`} · ${daemon.eventLoopP99Ms === undefined ? "event-loop delay unavailable" : `${daemon.eventLoopP99Ms.toFixed(1)} ms event-loop p99`} · up since ${formatRelative(new Date(daemon.startedAt).toISOString())}`
            : "Sync daemon not running — the app is watching sessions itself while open"}
        </span>
        {loginStart !== null ? (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={loginStart}
              onChange={(event) => {
                void providers.setDaemonLogin(event.target.checked)
              }}
              className="size-3 accent-current"
            />
            keep syncing when closed
          </label>
        ) : null}
        <button
          type="button"
          aria-label="Refresh provider profiles"
          onClick={() =>
            void providers.loadAll(true).then(() => providers.loadStatus())
          }
          className="pressable flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-fill-hover"
        >
          <RefreshCwIcon className="size-3" />
        </button>
      </p>
      <ListCard>
        {harnesses.map((entry) => (
          <ListCardRow key={entry.id} className="flex items-center gap-2.5">
            <HarnessIcon harness={entry.id} className="size-4" />
            <span className="min-w-0 flex-1 text-ui">{entry.name}</span>
            <span className="text-label text-faint">{entry.how}</span>
            {availability === null ? (
              <span className="w-14 shimmer text-right text-label text-faint">
                …
              </span>
            ) : availability[entry.id] ? (
              <span className="text-label text-added">Installed</span>
            ) : (
              <span className="text-label text-faint">Not installed</span>
            )}
          </ListCardRow>
        ))}
      </ListCard>

      <HarnessAccounts />
    </div>
  )
}

/**
 * Several logins per CLI, switchable — the Orca mechanism: each captured
 * account is an isolated config home selected by env var at spawn, with
 * everything except credentials symlinked back to the real home, so skills
 * and sessions stay identical across accounts. Usage windows come from the
 * providers' own endpoints; a bar near full is the reason to switch.
 */
function HarnessAccounts() {
  // Shared with the identity menu through state/accounts.ts; the section is
  // one of two readers, not the owner.
  const accounts = useAccounts((state) => state.accounts)
  const usage = useAccounts((state) => state.usage)
  const busyAccount = useAccounts((state) => state.busy)
  const accountProviders = useAccounts((state) => state.providers)
  const [capturing, setCapturing] = useState<string | null>(null)
  const [captureName, setCaptureName] = useState("")

  useEffect(() => {
    accountActions.load(true)
  }, [])

  const capture = async () => {
    if (!capturing || !captureName.trim()) return
    try {
      await accountActions.capture(capturing, captureName.trim())
      setCapturing(null)
      setCaptureName("")
    } catch (error) {
      toast.error("Account was not captured", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Try again", onClick: () => void capture() },
      })
    }
  }

  const select = (harness: string, name: string) =>
    accountActions.select(harness, name)

  const remove = (harness: string, name: string) =>
    accountActions.remove(harness, name)

  return (
    <>
      <div className="flex justify-end pt-4">
        <Action tone="ghost" onClick={() => accountActions.load(true)}>
          Refresh accounts
        </Action>
      </div>
      {accountProviders
        .filter((provider) => provider.mode === "selectable")
        .map((provider) => {
          const harness = provider.provider
          const rows = accounts.filter((account) => account.harness === harness)
          return (
            <div key={harness}>
              <Eyebrow className="pt-6 pb-2">{provider.label} accounts</Eyebrow>
              <p className="pb-2 text-ui leading-relaxed text-faint">
                Mako keeps each login isolated while sharing the same sessions,
                skills, and tools. The active account is used for new sessions.
              </p>
              {rows.map((account) => {
                const stats = usage[`${harness}:${account.name}`]
                const identity = account.email ?? account.name
                const key = `${harness}:${account.name}`
                return (
                  <div
                    key={account.name}
                    className={cn(
                      "group/account flex w-full items-center rounded-lg transition-colors duration-100",
                      account.active
                        ? "bg-raised ring-1 ring-hairline"
                        : "hover:bg-fill-hover"
                    )}
                  >
                    <button
                      type="button"
                      disabled={Boolean(busyAccount)}
                      onClick={() => void select(harness, account.name)}
                      className="pressable flex min-w-0 flex-1 items-center gap-3 px-2.5 py-2 text-left disabled:opacity-60"
                    >
                      <span
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center rounded-full text-label font-semibold",
                          account.active
                            ? "bg-fill-selected text-foreground"
                            : "bg-raised text-faint"
                        )}
                      >
                        {identity.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-none basis-56">
                        <span
                          className={cn(
                            "block truncate text-ui",
                            account.active
                              ? "font-medium text-foreground"
                              : "text-foreground/85"
                          )}
                        >
                          {identity}
                        </span>
                        <span className="block text-label text-faint">
                          {account.active
                            ? "Used for new sessions in Mako"
                            : account.source === "subrouter"
                              ? "Available from Subrouter"
                              : account.name === "default"
                                ? "The CLI's current login"
                                : `Captured as ${account.name}`}
                        </span>
                      </span>
                      <span className="min-w-0 flex-1">
                        {stats?.status === "ok" ? (
                          <span className="flex items-center gap-2">
                            <UsageBar window={stats.session} />
                            <UsageBar window={stats.weekly} />
                            {stats.plan ? (
                              <span className="text-label text-faint">
                                {stats.plan}
                              </span>
                            ) : null}
                          </span>
                        ) : stats ? (
                          <span className="text-label text-faint">
                            {stats.status === "stale-token"
                              ? (stats.detail ??
                                "Sign in again to refresh usage")
                              : stats.status === "missing-credentials"
                                ? "Sign in with the CLI to use this account"
                                : (stats.detail ??
                                  "Usage is temporarily unavailable")}
                          </span>
                        ) : (
                          <span className="shimmer text-label text-faint">
                            Loading usage…
                          </span>
                        )}
                      </span>
                      {account.active ? (
                        <span className="flex shrink-0 items-center gap-1 text-label text-foreground">
                          <CheckIcon className="size-3.5" />
                          Active
                        </span>
                      ) : busyAccount === key ? (
                        <span className="shrink-0 shimmer text-label text-faint">
                          Switching…
                        </span>
                      ) : null}
                    </button>
                    {account.name !== "default" &&
                    account.source !== "subrouter" ? (
                      <button
                        type="button"
                        aria-label={`Remove ${account.name}`}
                        disabled={Boolean(busyAccount)}
                        onClick={() => void remove(harness, account.name)}
                        className="pressable mr-1.5 rounded p-1 text-faint opacity-0 transition-opacity duration-100 group-hover/account:opacity-100 hover:text-foreground focus-visible:opacity-100"
                      >
                        <XIcon className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                )
              })}
              {capturing === harness ? (
                <div className="mt-2 rounded-lg bg-surface p-2.5 ring-1 ring-hairline">
                  <p className="pb-2 text-ui text-muted-foreground">
                    First run{" "}
                    <code className="font-mono text-foreground">
                      {provider.loginCommand}
                    </code>{" "}
                    in a terminal. Then name that login in Mako.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={captureName}
                      onChange={(event) => setCaptureName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void capture()
                      }}
                      placeholder="Name, such as Work"
                      className="h-7 w-44 rounded-md bg-raised px-2 text-ui text-foreground placeholder:text-faint focus:ring-1 focus:ring-hairline focus:outline-none"
                    />
                    <Action
                      disabled={!captureName.trim()}
                      onClick={() => void capture()}
                    >
                      Save current login
                    </Action>
                    <Action tone="ghost" onClick={() => setCapturing(null)}>
                      Cancel
                    </Action>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setCapturing(harness)}
                  className="pressable mt-2 rounded px-1 py-0.5 text-ui text-faint hover:bg-fill-hover hover:text-foreground"
                >
                  Add another account
                </button>
              )}
            </div>
          )
        })}
      {accountProviders
        .filter((provider) => provider.mode === "observed")
        .map((provider) => {
          const rows = accounts.filter(
            (account) => account.harness === provider.provider
          )
          return (
            <div key={provider.provider}>
              <Eyebrow className="pt-6 pb-2">
                {provider.label} credentials
              </Eyebrow>
              <p className="pb-2 text-ui leading-relaxed text-faint">
                {provider.label} manages these credentials. To add or refresh a
                login, run{" "}
                <code className="font-mono">{provider.loginCommand}</code> in a
                terminal, then refresh accounts.
              </p>
              {rows.length === 0 ? (
                <p className="rounded-lg bg-surface px-2.5 py-2 text-ui text-faint">
                  No {provider.label} credentials found.
                </p>
              ) : (
                rows.map((account) => {
                  const stats = usage[`${provider.provider}:${account.name}`]
                  const identity =
                    account.email ??
                    account.accountId ??
                    "Account identity unavailable"
                  return (
                    <div
                      key={account.name}
                      className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2"
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-label font-semibold text-faint">
                        {(account.providerId ?? account.name)
                          .slice(0, 1)
                          .toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-none basis-56">
                        <span className="block truncate text-ui text-foreground/85">
                          {identity}
                        </span>
                        <span className="block truncate text-label text-faint">
                          {account.providerId ?? account.name} ·{" "}
                          {authTypeLabel(account.authType)}
                        </span>
                      </span>
                      <span className="min-w-0 flex-1">
                        {account.email && account.accountId ? (
                          <span
                            className="block truncate text-label text-faint"
                            title={account.accountId}
                          >
                            Account {account.accountId}
                          </span>
                        ) : null}
                        {stats?.status === "ok" ? (
                          <span className="flex items-center gap-2">
                            <UsageBar window={stats.session} />
                            <UsageBar window={stats.weekly} />
                            {stats.plan ? (
                              <span className="text-label text-faint">
                                {stats.plan}
                              </span>
                            ) : null}
                          </span>
                        ) : stats ? (
                          <span className="text-label text-faint">
                            {stats.status === "stale-token"
                              ? (stats.detail ??
                                `${provider.label} must refresh this login`)
                              : stats.status === "missing-credentials"
                                ? "Credential details are unavailable"
                                : (stats.detail ?? "Usage is unavailable")}
                          </span>
                        ) : (
                          <span className="shimmer text-label text-faint">
                            Loading usage…
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-label text-faint">
                        Read-only
                      </span>
                    </div>
                  )
                })
              )}
            </div>
          )
        })}
    </>
  )
}

function authTypeLabel(type: "oauth" | "api" | "wellknown" | undefined) {
  if (type === "oauth") return "OAuth"
  if (type === "api") return "API key"
  if (type === "wellknown") return "Well-known"
  return "Unknown auth"
}

/** One window as a small bar: full is the signal, exact digits on hover. */
function UsageBar({
  window: win,
}: {
  window?: {
    usedPercent: number
    windowMinutes: number
    resetsAt: number | null
  } | null
}) {
  if (!win) return null
  const used = Math.max(0, Math.min(100, win.usedPercent))
  const label = usageWindowLabel(win.windowMinutes)
  return (
    <span
      className="flex items-center gap-1"
      title={`${used}% used${win.resetsAt ? ` · resets ${formatRelative(new Date(win.resetsAt).toISOString())}` : ""}`}
    >
      <span className="text-label text-faint">{label}</span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-raised">
        <span
          className={cn(
            "block h-full rounded-full",
            used >= 90 ? "bg-removed" : used >= 70 ? "bg-caution" : "bg-added"
          )}
          style={{ width: `${used}%` }}
        />
      </span>
      <span className="tabular text-label text-faint">{Math.round(used)}%</span>
    </span>
  )
}

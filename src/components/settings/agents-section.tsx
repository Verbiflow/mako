import { useEffect } from "react"
import { Segmented, SettingRow } from "@/components/ui/kit"
import { HARNESS_LABEL } from "@/components/rail/harness-meta"
import { setPref, usePrefs } from "@/state/prefs"
import { providers, useProviders } from "@/state/providers"
import { providerConnections } from "@/state/provider-connections"
import { accounts } from "@/state/accounts"
import { ProviderTable } from "./provider-table"
import { cn } from "@/lib/utils"
import { formatBytes, formatRelative } from "@/lib/format"

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
    providerConnections.load()
    accounts.load()
    void providers.loadRuntimeUpdates()
  }, [])

  return (
    <div className="flex flex-col gap-1">
      <p className="pb-3 text-ui leading-relaxed text-muted-foreground">
        Manage sign-in and updates for the agents Mako uses on this machine.
      </p>
      <ProviderTable harnesses={harnesses} availability={availability} />
      <div className="mt-5 border-t border-hairline pt-4">
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
        </p>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState, type ComponentType } from "react"
import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  ExternalLinkIcon,
  MailIcon,
  MessageCircleIcon,
  MonitorIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { FaGithub, FaGoogle, FaMicrosoft, FaSlack } from "react-icons/fa"
import { SiAtlassian, SiLinear, SiNotion, SiSentry } from "react-icons/si"
import { Action, Eyebrow } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import type { IntegrationCategory, IntegrationRecord } from "@/lib/types"
import { integrations, useIntegrations } from "@/state/integrations"
import { Shimmer } from "@/components/ui/shimmer"

const CATEGORIES: IntegrationCategory[] = [
  "Communication",
  "Planning",
  "Development",
  "Productivity",
  "Local",
]

const LOGOS = {
  linear: SiLinear,
  github: FaGithub,
  slack: FaSlack,
  notion: SiNotion,
  teams: FaMicrosoft,
  sentry: SiSentry,
  google: FaGoogle,
  atlassian: SiAtlassian,
  "mako-backend": BotIcon,
  "local-browser": MonitorIcon,
  "computer-use": MonitorIcon,
  "apple-mail": MailIcon,
  "apple-messages": MessageCircleIcon,
} satisfies Record<
  string,
  ComponentType<{ "aria-label"?: string; className?: string }>
>

export function IntegrationsSection() {
  const state = useIntegrations((value) => value)
  const [query, setQuery] = useState("")

  useEffect(() => {
    void integrations.load()
  }, [])

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase()
    const records = (state.snapshot?.integrations ?? []).filter((record) =>
      [
        record.label,
        record.description,
        record.category,
        ...record.capabilities,
      ]
        .join(" ")
        .toLowerCase()
        .includes(term)
    )
    return CATEGORIES.map((category) => ({
      category,
      records: records.filter((record) => record.category === category),
    })).filter((group) => group.records.length > 0)
  }, [query, state.snapshot])

  return (
    <div>
      <div className="flex items-start gap-4 pb-5">
        <p className="min-w-0 flex-1 text-ui leading-relaxed text-muted-foreground">
          Bring work context into every agent. Slack runs through Mako’s
          authenticated backend; Google uses a signed-in local browser session.
          Browser and computer control never leave this Mac.
        </p>
        <Action
          tone="outline"
          disabled={state.status === "loading"}
          onClick={() => void integrations.load()}
        >
          <RefreshCwIcon className="size-3" />
          Refresh
        </Action>
      </div>

      <label className="mb-5 flex h-8 items-center gap-2 rounded-md bg-surface px-2.5 ring-1 ring-hairline focus-within:ring-border">
        <SearchIcon className="size-3.5 shrink-0 text-faint" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search integrations"
          aria-label="Search integrations"
          className="min-w-0 flex-1 bg-transparent text-ui text-foreground placeholder:text-faint focus:outline-none"
        />
      </label>

      {state.status === "loading" && !state.snapshot ? (
        <p className="text-ui text-faint"><Shimmer text="Checking connections…" /></p>
      ) : null}

      {groups.map((group) => (
        <section key={group.category} className="pb-5 last:pb-0">
          <Eyebrow className="px-0 pb-1.5">{group.category}</Eyebrow>
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {group.records.map((record) => (
              <IntegrationCard key={record.id} record={record} />
            ))}
          </div>
        </section>
      ))}

      {state.snapshot && groups.length === 0 ? (
        <p className="rounded-lg bg-surface px-3 py-8 text-center text-ui text-faint ring-1 ring-hairline">
          No integrations match “{query.trim()}”.
        </p>
      ) : null}

      {state.error ? (
        <p className="pt-3 text-label text-removed">{state.error}</p>
      ) : null}
    </div>
  )
}

function IntegrationCard({ record }: { record: IntegrationRecord }) {
  const state = record.connection
  const updatingDriver = useIntegrations((value) => value.updatingDriver)
  const configured = state.kind === "connected" || state.kind === "ready"
  return (
    <div className="contain-turn flex min-h-36 flex-col rounded-lg bg-surface p-3 ring-1 ring-hairline">
      <div className="flex items-start gap-2.5">
        <IntegrationLogo record={record} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-ui font-medium">{record.label}</span>
            <TrustMark trust={record.trust} />
          </span>
          <span className="mt-0.5 block text-label leading-relaxed text-muted-foreground">
            {record.description}
          </span>
        </span>
        <StatusMark record={record} />
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {record.capabilities.map((capability) => (
          <span
            key={capability}
            className="rounded bg-raised px-1.5 py-0.5 text-label text-faint"
          >
            {capability}
          </span>
        ))}
      </div>

      <div className="mt-auto flex items-end gap-2 pt-3">
        <span className="min-w-0 flex-1 truncate text-label text-faint">
          {state.detail}
        </span>
        {state.kind === "needs-permission" ? (
          <Action
            tone="outline"
            onClick={() => void integrations.requestComputerPermissions()}
          >
            Grant access
          </Action>
        ) : state.kind === "needs-update" ? (
          <Action
            tone="outline"
            disabled={updatingDriver}
            onClick={() => void integrations.updateComputerDriver()}
          >
            {updatingDriver ? "Updating…" : "Update driver"}
          </Action>
        ) : state.kind === "setup" ? (
          <Action
            tone="outline"
            onClick={() => {
              if (record.setupUrl) {
                void integrations.openSetup(record.setupUrl)
                return
              }
              openMcpSettings()
            }}
          >
            Set up
            {record.setupUrl ? <ExternalLinkIcon className="size-3" /> : null}
          </Action>
        ) : state.kind === "conflict" ? (
          <Action tone="outline" onClick={openMcpSettings}>
            Review
          </Action>
        ) : configured &&
          (record.auth === "provider-oauth" ||
            record.auth === "provider-cli") ? (
          <Action tone="ghost" onClick={openMcpSettings}>
            Manage
          </Action>
        ) : null}
      </div>
    </div>
  )
}

function IntegrationLogo({ record }: { record: IntegrationRecord }) {
  const Logo = Object.entries(LOGOS).find(([id]) => id === record.id)?.[1]
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-raised text-muted-foreground ring-1 ring-hairline">
      {Logo ? (
        <Logo aria-label={`${record.label} logo`} className="size-4.5" />
      ) : (
        <span className="font-mono text-label font-semibold">
          {monogram(record.label)}
        </span>
      )}
    </span>
  )
}

function TrustMark({ trust }: { trust: IntegrationRecord["trust"] }) {
  return trust === "community" ? (
    <span className="text-label text-faint">community</span>
  ) : (
    <ShieldCheckIcon
      aria-label={
        trust === "official" ? "Official integration" : "Mako integration"
      }
      className="size-3 text-faint"
    />
  )
}

function StatusMark({ record }: { record: IntegrationRecord }) {
  const kind = record.connection.kind
  if (kind === "connected" || kind === "ready") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-label text-added">
        <CheckIcon className="size-3" />
        {kind === "connected" ? "Connected" : "Ready"}
      </span>
    )
  }
  if (
    kind === "conflict" ||
    kind === "needs-permission" ||
    kind === "needs-update"
  ) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-label text-caution">
        <AlertTriangleIcon className="size-3" />
        {kind === "conflict"
          ? "Conflict"
          : kind === "needs-update"
            ? "Update"
            : "Permissions"}
      </span>
    )
  }
  return (
    <span
      className={cn(
        "shrink-0 text-label",
        kind === "unavailable" ? "text-muted-foreground" : "text-faint"
      )}
    >
      {kind === "unavailable" ? "Unavailable" : "Not connected"}
    </span>
  )
}

function monogram(label: string): string {
  return label
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
}

function openMcpSettings(): void {
  window.dispatchEvent(new CustomEvent("mako:settings", { detail: "mcp" }))
}

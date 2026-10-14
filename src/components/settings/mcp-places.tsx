import { Trash2Icon } from "lucide-react"
import { Chip, IconAction, Toggle } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { homeRelative } from "@/lib/skill-matrix"
import type { AuthoringView } from "@/lib/types"
import { authoring, useAuthoring } from "@/state/native-authoring"
import { AUTHORING_SCOPES } from "@/lib/authoring-scopes"
import { Hint, PlanPanel } from "./authoring-plan"

/**
 * Every file an MCP server is set in, agent by agent, with its own switch:
 * the server's key, or the list of names the agent keeps turned off. A
 * change is previewed as the diff of that file, credentials redacted.
 */
export function McpPlaces({ name, views }: { name: string; views: readonly AuthoringView[] }) {
  const plan = useAuthoring((state) => state.plan)
  const busy = useAuthoring((state) => state.busy)
  const places = views.flatMap((view) => view.entries.filter((entry) => entry.name === name).map((entry) => ({ view, entry, source: view.sources.find((source) => source.id === entry.sourceId) })))
  if (!places.length) return null
  return (
    <div className="mt-1.5 flex flex-col gap-1" aria-label={`Where ${name} is set`}>
      {places.map(({ view, entry, source }) => {
        const mine = plan?.target.family === "mcp" && "entryId" in plan.change && plan.change.entryId === entry.id ? plan : null
        const on = { provider: view.provider, family: "mcp" as const }
        return (
          <div key={entry.id}>
            <div className="flex items-center gap-2 text-label">
              <HarnessIcon harness={view.provider} className="size-3" />
              <span className="text-muted-foreground">{view.label}</span>
              {source ? <Chip>{AUTHORING_SCOPES[source.scope]}</Chip> : null}
              <span className="min-w-0 flex-1 truncate font-mono text-faint" title={source?.path}>{source ? homeRelative(source.path) : ""}</span>
              {entry.shadowedBy ? <Hint label="Not used" detail="Another file this agent reads wins this name." /> : null}
              {view.operations.remove.supported && source?.writable.supported ? (
                <IconAction label={`Remove ${name} from this file`} size="xs" disabled={busy} onClick={() => void authoring.preview({ kind: "remove", entryId: entry.id }, on)}>
                  <Trash2Icon />
                </IconAction>
              ) : null}
              {view.operations.disable.supported ? (
                <Toggle label={`${entry.enabled ? "Turn off" : "Turn on"} ${name} for ${view.label}`} on={entry.enabled} disabled={busy} onChange={() => void authoring.preview({ kind: "enable", entryId: entry.id, enabled: !entry.enabled }, on)} />
              ) : <Hint label={entry.enabled ? "On" : "Off"} detail={view.operations.disable.supported ? "" : view.operations.disable.reason} />}
            </div>
            {mine ? <PlanPanel plan={mine} /> : null}
          </div>
        )
      })}
    </div>
  )
}

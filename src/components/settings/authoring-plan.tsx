import { Action, Chip } from "@/components/ui/kit"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AUTHORING_SCOPES } from "@/lib/authoring-scopes"
import { homeRelative } from "@/lib/skill-matrix"
import { cn } from "@/lib/utils"
import type { AuthoringPlan } from "@/lib/types"
import { authoring, useAuthoring } from "@/state/native-authoring"

const EFFECT = {
  "create-file": "Creates the file",
  "edit-file": "Edits the file",
  "delete-file": "Deletes the file",
  unchanged: "Nothing to change",
} as const satisfies Record<AuthoringPlan["effect"], string>

/** The diff of the one file a change writes, credentials redacted, with the go-ahead beside it. */
export function PlanPanel({ plan }: { plan: AuthoringPlan }) {
  const busy = useAuthoring((state) => state.busy)
  return (
    <div className="mt-2 rounded-md bg-background ring-1 ring-hairline" role="group" aria-label="Review the change">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-2.5 py-2">
        <span className="min-w-0 flex-1 text-ui">{plan.summary}</span>
        <Chip>{AUTHORING_SCOPES[plan.scope]}</Chip>
        <Chip tone={plan.effect === "delete-file" ? "caution" : "neutral"}>{EFFECT[plan.effect]}</Chip>
      </div>
      <p className="truncate px-2.5 pt-2 font-mono text-label text-faint" title={plan.path}>{homeRelative(plan.path)}</p>
      <DiffLines plan={plan} />
      <div className="flex items-center gap-2 px-2.5 pb-2.5">
        <Action tone="solid" disabled={busy} onClick={() => void authoring.apply()}>{busy ? "Writing…" : plan.effect === "unchanged" ? "Done" : "Apply"}</Action>
        <Action disabled={busy} onClick={() => authoring.dismiss()}>Back</Action>
        <span className="text-label text-faint">{plan.backup ? "The file as it is now is kept in Mako's backups." : ""}</span>
      </div>
    </div>
  )
}

function DiffLines({ plan }: { plan: AuthoringPlan }) {
  if (!plan.lines.some((line) => line.kind !== "context")) return <p className="px-2.5 py-2 text-label text-faint">The file already says this.</p>
  return (
    <div className="my-2 max-h-72 overflow-auto font-mono text-label leading-[1.6]">
      {plan.lines.map((line, index) => (
        <div key={index} className={cn("flex gap-2 px-2.5", line.kind === "add" && "bg-added/10 text-added", line.kind === "remove" && "bg-removed/10 text-removed", line.kind === "context" && "text-faint")}>
          <span className="w-8 shrink-0 text-right opacity-60 select-none">{line.before ?? line.after ?? ""}</span>
          <span className="w-2 shrink-0 opacity-60 select-none">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>
          <span className="whitespace-pre">{line.text || " "}</span>
        </div>
      ))}
    </div>
  )
}

export function TrustChip({ state, detail }: { state: string; detail: string }) {
  const label = { trusted: "Trusted", untrusted: "Not trusted", modified: "Changed since trusted", managed: "Managed", unasked: "Runs without asking" }[state] ?? state
  return <Hint label={label} detail={detail} tone={state === "untrusted" || state === "modified" ? "caution" : "neutral"} />
}

export function Hint({ label, detail, tone = "neutral" }: { label: string; detail: string; tone?: "neutral" | "caution" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0}><Chip tone={tone}>{label}</Chip></span></TooltipTrigger>
      <TooltipContent className="max-w-80 leading-relaxed">{detail}</TooltipContent>
    </Tooltip>
  )
}

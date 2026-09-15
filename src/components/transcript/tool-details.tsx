import type { ToolDetail } from "@mako/sessions"
import { CheckIcon, CircleIcon, CircleDotIcon, ListChecksIcon } from "lucide-react"
import { Prose } from "./markdown"
import { EditPreview } from "./tool-views"
import { viewer } from "@/state/viewer"
import { useTranscriptSource } from "./source-context"

export function ToolDetails({details}: {details: ToolDetail[]}) {
  const source = useTranscriptSource()
  return <div className="divide-y divide-hairline">{details.map((detail, index) => {
    switch (detail.type) {
      case "location": return <div key={index}><button type="button" className="pressable p-2.5 text-ui underline" onClick={() => void viewer.open(detail.path, undefined, source.threadPath, source.liveId)}>{detail.path}{detail.line !== undefined ? `:${detail.line}` : ""}</button></div>
      case "plan": return <PlanSummary key={index} plan={detail} />
      case "terminal": return <p key={index} className="p-2.5 text-ui text-faint">Provider terminal <code>{detail.terminalId}</code>. This provider has not supplied a reconnectable terminal.</p>
      case "diff": return <div key={index}><button type="button" className="pressable p-2.5 text-ui underline" onClick={() => void viewer.open(detail.path, undefined, source.threadPath, source.liveId)}>{detail.path}</button><EditPreview before={detail.oldText ?? ""} after={detail.newText} /></div>
    }
  })}</div>
}

export function PlanSummary({plan}: {plan: Extract<ToolDetail, {type: "plan"}>}) {
  const completed = plan.entries.filter((entry) => /^(?:completed|done)$/i.test(entry.status)).length
  return <div className="rounded-md border border-hairline px-3 py-2 text-ui">
    <div className="mb-2 flex items-center gap-2 text-muted-foreground"><ListChecksIcon className="size-3.5" /><span>Plan · {completed} of {plan.entries.length} steps complete</span></div>
    <ol className="space-y-1.5">{plan.entries.map((entry, index) => <li key={index} className="flex items-start gap-2">
      {/^(?:completed|done)$/i.test(entry.status) ? <CheckIcon className="mt-1 size-3 shrink-0 text-muted-foreground" /> : /^(?:in_progress|running)$/i.test(entry.status) ? <CircleDotIcon className="mt-1 size-3 shrink-0 text-foreground" /> : <CircleIcon className="mt-1 size-3 shrink-0 text-faint" />}
      <span className="sr-only">{entry.status}: </span><Prose text={entry.content} />
    </li>)}</ol>
  </div>
}

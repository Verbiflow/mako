import { useEffect } from "react"
import { Action, Toggle } from "@/components/ui/kit"
import { formatRelative } from "@/lib/format"
import { triggerWords } from "@mako/host/contracts/automations"
import { automations, useAutomations } from "@/state/automations"

/**
 * Every served project's automations: each a stored agent start with its triggers. Each arrives switched off: the
 * definitions come from a file in the project, but whether one may start Threads on this machine is decided here.
 * Agents' proposals wait here and in the Inbox for the person's decision.
 */
export function AutomationsSection() {
  const projects = useAutomations((state) => state.projects)

  useEffect(() => {
    void automations.load()
  }, [])

  return (
    <div className="flex flex-col gap-1">
      <p className="pb-2 text-ui leading-relaxed text-muted-foreground">
        Agent starts that run on a schedule, on a commit, or when you press Run now, defined in each project's{" "}
        <code className="text-faint">.mako/automations.json</code>. Each one starts switched off, and one whose
        definition changes after you turn it on pauses until you turn it on again.
      </p>
      {projects.every((project) => project.automations.length === 0 && project.proposals.length === 0) ? (
        <p className="bg-raised px-3 py-4 text-center text-ui text-faint">No project open here has automations.</p>
      ) : null}
      {projects.map((project) => (
        <div key={project.project} className="flex flex-col gap-1">
          {project.automations.length || project.proposals.length ? <p className="pt-2 text-label text-faint">{project.project}</p> : null}
          {project.file.error ? <p className="text-ui text-faint">{project.file.error}</p> : null}
          {project.proposals.filter((proposal) => proposal.status === "pending").map((proposal) => (
            <div key={proposal.id} className="flex items-center gap-2 bg-raised px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-ui">
                {proposal.by.title ?? "An agent"} proposes to {proposal.change} {proposal.automation}
                {proposal.why ? `: ${proposal.why}` : ""}
              </span>
              <Action tone="ghost" onClick={() => void automations.decide(proposal.id, false)}>Decline</Action>
              <Action tone="outline" onClick={() => void automations.decide(proposal.id, true)}>Approve</Action>
            </div>
          ))}
          {project.automations.map((view) => (
            <div key={view.definition.id} className="bg-raised px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Toggle label={view.definition.name} on={view.local.enabled} onChange={() => void automations.setEnabled(project.project, view.definition.id, !view.local.enabled)} />
                <span className="min-w-0 flex-1 truncate text-ui font-medium">{view.definition.name}</span>
                <Action tone="ghost" onClick={() => automations.run(project.project, view.definition.id)}>Run now</Action>
              </div>
              <p className="mt-1 pl-[42px] text-label text-faint">
                {view.definition.triggers.map(triggerWords).join(" · ")}
                {view.lastRun ? ` · last run ${view.lastRun.status} ${formatRelative(new Date(view.lastRun.at).toISOString())}` : ""}
              </p>
              {view.local.paused ? <p className="mt-1 pl-[42px] text-label text-faint">{view.local.paused.reason}</p> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

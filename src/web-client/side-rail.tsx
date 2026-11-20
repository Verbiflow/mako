import { SideTab, SideTabs } from "@/components/stage/side-tab"
import { AgentsReading } from "@/components/stage/side-readings"
import { useAgentsLabel, useAgentsOffered } from "@/state/agents-offered"
import { openAgents, useDeskFin } from "./agents-open"
import { openFiles } from "./files-open"
import { SetupRailRow } from "./setup-rail-row"
import { deskReviewCode, openReview, touchReviewCode } from "./review-open"

/**
 * The right panel in the browser, the desktop's twin: one bar of tabs, Changes, Files, Agents and Setup, the open one
 * raised and what it opened under it. They take turns, so a tab is all it takes to go between them. On a tablet's sheet
 * and a phone's full-screen one (`touch`) the same bar carries the two that open there, Changes and Files, at a
 * finger's height; Agents and Setup are the laptop's.
 */
export function WebSideRail({ active, conversation, touch = false }: { active: "changes" | "files" | "agents" | "setup"; conversation: string; touch?: boolean }) {
  const apex = useDeskFin((state) => state.fin?.apex)
  const offered = useAgentsOffered(apex)
  const agentsLabel = useAgentsLabel(apex)
  return (
    <SideTabs label="Right rail" touch={touch}>
      <SideTab
        label="Changes"
        active={active === "changes"}
        touch={touch}
        data-surface-id="changes"
        onClick={() => {
          if (active === "changes") return
          void (touch ? touchReviewCode : deskReviewCode).read()
          openReview({ conversation, scope: { kind: "thread" } })
        }}
      />
      <SideTab label="Files" active={active === "files"} touch={touch} data-surface-id="files" onClick={() => active !== "files" && openFiles({ conversation })} />
      {!touch && (offered || active === "agents") ? (
        <SideTab label={agentsLabel} active={active === "agents"} data-surface-id="agents" reading={<AgentsReading conversation={apex} />} onClick={() => active !== "agents" && openAgents()} />
      ) : null}
      {!touch ? <SetupRailRow open={active === "setup"} conversation={conversation} /> : null}
    </SideTabs>
  )
}

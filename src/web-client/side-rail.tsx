import { FilesIcon, GitCompareIcon } from "lucide-react"
import { LineCounts } from "@/components/inspector/change-marks"
import { RailRow } from "@/components/rail/rail-row"
import { moveInRail } from "@/components/rail/rail-keys"
import { AgentsReading } from "@/components/stage/side-readings"
import { ApexMark } from "@/components/ui/apex-mark"
import { recordedTurnChanges } from "@/lib/turn-changes"
import { useAcp } from "@/state/acp"
import { useAgentsOffered } from "@/state/agents-offered"
import { shallowEqual } from "@/state/store"
import { agentsConversation, openAgents, useDeskFin } from "./agents-open"
import { openFiles } from "./files-open"
import { deskReviewCode, openReview } from "./review-open"
import { changedRequests } from "./review-model"

/** How much the newest turn with changes changed, as Changes here reads a Session by its turns. */
function ChangesReading({ conversation }: { conversation: string }) {
  const lines = useAcp((state) => {
    const live = state.conversations[conversation]
    const summary = recordedTurnChanges(live?.kind === "live" ? changedRequests(live.requests ?? []).at(-1)?.changes : undefined)
    return { insertions: summary?.insertions ?? null, deletions: summary?.deletions ?? null }
  }, shallowEqual)
  return <LineCounts insertions={lines.insertions} deletions={lines.deletions} />
}

/**
 * The right rail in a laptop's browser, the desktop's twin: a row for Changes, Files and Agents with their readings,
 * the one open lit, and what it opened under them. The three take turns, so a row is all it takes to go between them.
 */
export function WebSideRail({ active, conversation }: { active: "changes" | "files" | "agents"; conversation: string }) {
  const offered = useAgentsOffered()
  const fin = useDeskFin((state) => state.agent !== null)
  return (
    <nav role="tablist" aria-label="Right rail" aria-orientation="vertical" data-side-rail className="flex shrink-0 flex-col gap-px px-2 pt-1.5 pb-2" onKeyDown={moveInRail}>
      <RailRow
        role="tab"
        aria-selected={active === "changes"}
        aria-current={undefined}
        tabIndex={active === "changes" ? 0 : -1}
        data-surface-id="changes"
        icon={<GitCompareIcon />}
        label="Changes"
        open={active === "changes"}
        end={<ChangesReading conversation={conversation} />}
        onClick={() => {
          if (active === "changes") return
          void deskReviewCode.read()
          openReview({ conversation, scope: { kind: "thread" } })
        }}
      />
      <RailRow
        role="tab"
        aria-selected={active === "files"}
        aria-current={undefined}
        tabIndex={active === "files" ? 0 : -1}
        data-surface-id="files"
        icon={<FilesIcon />}
        label="Files"
        open={active === "files"}
        onClick={() => active !== "files" && openFiles({ conversation })}
      />
      {offered || fin || active === "agents" ? (
        <RailRow
          role="tab"
          aria-selected={active === "agents"}
          aria-current={undefined}
          tabIndex={active === "agents" ? 0 : -1}
          data-surface-id="agents"
          icon={<ApexMark />}
          label="Agents"
          open={active === "agents"}
          end={<AgentsReading />}
          onClick={() => active !== "agents" && openAgents(agentsConversation(conversation))}
        />
      ) : null}
    </nav>
  )
}

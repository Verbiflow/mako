import { FilesIcon, GitCompareIcon } from "lucide-react"
import { RailRow } from "@/components/rail/rail-row"
import { openFiles } from "./files-open"
import { deskReviewCode, openReview } from "./review-open"

/**
 * The right rail in a laptop's browser, the desktop's twin: a row for Changes and one for Files, the one open lit, and
 * what it opened under them. The two take turns, so a row is all it takes to go from one to the other.
 */
export function WebSideRail({ active, conversation }: { active: "changes" | "files"; conversation: string }) {
  return (
    <nav aria-label="Right rail" data-side-rail className="flex shrink-0 flex-col gap-px px-2 pt-1.5 pb-2">
      <RailRow
        data-surface-id="changes"
        icon={<GitCompareIcon />}
        label="Changes"
        open={active === "changes"}
        onClick={() => {
          if (active === "changes") return
          void deskReviewCode.read()
          openReview({ conversation, scope: { kind: "thread" } })
        }}
      />
      <RailRow data-surface-id="files" icon={<FilesIcon />} label="Files" open={active === "files"} onClick={() => active !== "files" && openFiles({ conversation })} />
    </nav>
  )
}

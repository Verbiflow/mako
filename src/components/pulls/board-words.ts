import { toast } from "sonner"
import { pullSection, type BoardPull } from "@mako/host/contracts/project-pulls"

/* What the Pull requests rows say and do beyond drawing: shared by the panel and the page. */

/** The code column's width: the longest code in the list, so every title starts at the same place. */
export function codeWidth(codes: readonly string[]): string {
  return `${Math.max(3, ...codes.map((code) => code.length))}ch`
}

/** The quiet words after a title, for a reader who can't see the hue: why it needs them, or its review. */
export function pullNote(pull: BoardPull): string | undefined {
  const section = pullSection(pull)
  if (section === "needs-you") {
    if (pull.reviewRequested) return "Review requested"
    if (pull.review === "changes") return "Changes requested"
    return "Checks failing"
  }
  if (pull.review === "approved" && pull.state === "open") return "Approved"
  if (pull.review === "changes" && pull.state === "open") return "Changes requested"
  return undefined
}

export function copyReference(row: { repository: string; number: number; url: string }): void {
  void navigator.clipboard.writeText(`${row.repository}#${row.number}`)
  toast.success(`Copied ${row.repository}#${row.number}`)
}


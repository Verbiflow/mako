import {
  AppWindowMacIcon,
  FileIcon,
  FileTextIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ImageIcon,
  MessageSquareTextIcon,
  MousePointerClickIcon,
  QuoteIcon,
  SquareTerminalIcon,
} from "lucide-react"
import type { ContextDetail } from "@/lib/context-detail"
import type { AttachmentOrigin } from "@/lib/attachments"
import { cn } from "@/lib/utils"

/**
 * The mark a context chip wears over its `@`, the same in the draft and in
 * the transcript: what it is, at a glance, in the text colour. A file reads
 * by what it holds; something Mako made reads by where it came from.
 */
export function ContextGlyph({
  detail,
  origin,
  mimeType,
  className,
}: {
  detail?: ContextDetail["kind"]
  origin?: AttachmentOrigin
  mimeType?: string
  className?: string
}) {
  const Icon =
    detail === "comment"
      ? MessageSquareTextIcon
      : detail === "element"
        ? MousePointerClickIcon
        : detail === "quote"
          ? QuoteIcon
          : detail === "pull-request" || origin === "pull-request"
            ? GitPullRequestIcon
            : origin === "terminal"
              ? SquareTerminalIcon
              : origin === "git-conflicts"
                ? GitMergeIcon
                : origin === "window"
                  ? AppWindowMacIcon
                  : mimeType?.startsWith("image/")
                    ? ImageIcon
                    : mimeType?.startsWith("text/")
                      ? FileTextIcon
                      : FileIcon
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />
}

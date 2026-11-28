import { Action } from "@/components/ui/kit"
import { desktop } from "@/state/desktop"
import { prefsStore } from "@/state/prefs"
import type { GitDiffPreview } from "@/lib/types"
import { cn } from "@/lib/utils"
import { FileTextIcon } from "lucide-react"

export function GitDiffPreviewView({
  path,
  preview,
}: {
  path: string
  preview: GitDiffPreview
}) {
  // A pull request's file (`url`): named by its path, opened on GitHub; nothing here stages it.
  const remote = preview.kind === "patch" ? preview.url : undefined
  return (
    <section aria-label={`Large diff preview: ${path}`} className="min-w-0">
      <div className="flex items-start gap-2 border-b border-hairline bg-shell/40 px-3 py-2.5">
        <FileTextIcon className="mt-0.5 size-3.5 shrink-0 text-faint" />
        <div className="min-w-0 flex-1">
          <p className="text-ui text-muted-foreground">
            {remote
              ? path
              : preview.kind === "patch"
                ? "Lightweight diff preview"
                : "Preview available in your editor"}
          </p>
          {remote ? null : (
            <p className="mt-0.5 text-label leading-relaxed text-faint">
              {preview.kind === "unavailable"
                ? preview.reason
                : `${preview.limited ? "Preview capped at 1,000 lines or 128 KB. " : ""}Staging and committing use the complete file.`}
            </p>
          )}
        </div>
        <Action
          size="xs"
          onClick={() =>
            void (remote ? desktop.openUrl(remote) : desktop.openInEditor(path, prefsStore.get().externalEditor))
          }
        >
          {remote ? "Open on GitHub" : "Open in editor"}
        </Action>
      </div>
      {preview.kind === "patch" ? (
        <pre
          className="text-code overflow-auto p-3 font-mono leading-5"
          data-large-diff
        >
          {preview.contents.split("\n").map((line, index) => (
            <span
              key={index}
              className={cn(
                "block min-h-5",
                line.startsWith("+") && !line.startsWith("+++")
                  ? "text-added"
                  : line.startsWith("-") && !line.startsWith("---")
                    ? "text-removed"
                    : "text-muted-foreground"
              )}
            >
              {line || " "}
            </span>
          ))}
        </pre>
      ) : null}
    </section>
  )
}

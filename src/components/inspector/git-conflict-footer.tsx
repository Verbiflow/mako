import { useState } from "react"
import { CheckIcon, CopyIcon, GitMergeIcon, TerminalSquareIcon } from "lucide-react"
import { IconAction } from "@/components/ui/kit"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { git } from "@/state/git"
import { toast } from "sonner"

export function CopyGitContextButton({ busy = false }: { busy?: boolean }) {
  const [copying, setCopying] = useState(false)
  const copy = async () => {
    setCopying(true)
    try {
      if (await git.copyConflictContext()) toast.success("Git context copied. Paste it into any chat.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally { setCopying(false) }
  }
  return <IconAction size="xs" label="Copy Git context" side="top" disabled={busy || copying} aria-busy={copying} className="shrink-0 text-muted-foreground" onClick={() => void copy()}><CopyIcon className="size-3.5" /></IconAction>
}

export function GitConflictFooter({ count, operation, busy, detail }: { count: number; operation?: string; busy: boolean; detail?: string }) {
  return <div data-commit-box data-git-remote-notice={count ? "" : undefined} className="shrink-0 border-t border-hairline px-3 py-1.5 text-label">
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-2 font-medium">
        {count ? <GitMergeIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        {count ? `${count} conflicted ${count === 1 ? "file" : "files"}` : `Ready to continue ${operation}`}
      </span>
      <span className="flex shrink-0 items-center gap-1">{count ? <CopyGitContextButton busy={busy} /> : null}{detail ? <GitDetailsButton detail={detail} /> : null}</span>
    </div>

  </div>
}

export function GitDetailsButton({ detail }: { detail: string }) {
  return <Popover>
    <PopoverTrigger asChild><IconAction size="xs" label="View Git details" side="top" className="shrink-0 text-faint"><TerminalSquareIcon className="size-3.5" /></IconAction></PopoverTrigger>
    <PopoverContent data-git-details side="top" align="end" className="w-[min(28rem,calc(100vw-2rem))] p-0">
      <div className="border-b border-hairline px-3 py-2 text-label font-medium">Git details</div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-label leading-relaxed text-muted-foreground">{detail}</pre>
    </PopoverContent>
  </Popover>
}

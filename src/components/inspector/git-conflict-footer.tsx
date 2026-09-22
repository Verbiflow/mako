import { useState } from "react"
import { CheckIcon, CopyIcon, GitMergeIcon } from "lucide-react"
import { IconAction } from "@/components/ui/kit"
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

export function GitConflictFooter({ count, operation, busy }: { count: number; operation?: string; busy: boolean }) {
  return <div data-commit-box className="shrink-0 border-t border-hairline px-3 py-2.5 text-label">
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-2 font-medium">
        {count ? <GitMergeIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        {count ? `${count} ${count === 1 ? "conflict" : "conflicts"}` : `Ready to continue ${operation}`}
      </span>
      {count ? <CopyGitContextButton busy={busy} /> : null}
    </div>
    <p className="mt-1 text-muted-foreground">{count ? <>Paste into any chat, or choose <span className="text-foreground">Git conflicts</span> in the <span className="font-mono">@</span> menu.</> : "Review the staged resolution, then continue."}</p>
  </div>
}

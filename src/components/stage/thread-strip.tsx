import { memo } from "react"
import { XIcon } from "lucide-react"
import { activeAcp, useAcp } from "@/state/acp"
import { threads, useThreads } from "@/state/threads"
import { closeThreadTab, useThreadTabs } from "@/state/thread-tabs"
import { sameThreadStatus, threadStatus } from "@/state/thread-status"
import { ThreadStatusMark } from "@/components/rail/thread-status"
import { cn } from "@/lib/utils"

/**
 * The sessions you have open, one strip above the workbench. A tab keeps
 * the whole workbench state behind it — the transcript's place, the draft,
 * the surfaces — so leaving a thread and coming back is free.
 */
export const ThreadStrip = memo(function ThreadStrip() {
  const tabs = useThreadTabs((state) => state.tabs)
  const viewingPath = useThreads((state) => state.viewing?.ref.path)
  const liveThreadPath = useAcp((state) => activeAcp(state)?.threadPath)
  const activePath = viewingPath ?? liveThreadPath ?? null
  // One open thread is already named by the workbench's own tab; a strip that
  // repeats it reads as a second tab bar, not as somewhere to switch.
  if (tabs.length < 2) return null
  return (
    <div
      role="tablist"
      aria-label="Open threads"
      className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-hairline bg-shell px-1.5"
    >
      {tabs.map((path) => (
        <ThreadTab key={path} path={path} active={path === activePath} />
      ))}
    </div>
  )
})

const ThreadTab = memo(function ThreadTab({
  path,
  active,
}: {
  path: string
  active: boolean
}) {
  const ref = useThreads((state) =>
    state.threads.find((thread) => thread.path === path)
  )
  const status = useThreads(
    (state) => (ref ? threadStatus(ref, state) : { kind: "idle" as const }),
    sameThreadStatus
  )
  if (!ref) return null
  const title = ref.title ?? "Untitled session"
  const close = () => {
    closeThreadTab(path)
    if (active) threads.closeViewer()
  }
  return (
    <div
      role="tab"
      aria-selected={active}
      className={cn(
        "group/tab flex min-w-0 items-center gap-1 rounded-md px-2 py-0.5 text-ui",
        active
          ? "bg-fill-selected text-foreground"
          : "text-muted-foreground hover:bg-fill-hover"
      )}
    >
      <button
        type="button"
        onClick={() => void threads.view(ref)}
        className="pressable flex min-w-0 items-center gap-1.5"
      >
        <ThreadStatusMark status={status} />
        <span className="max-w-44 truncate">{title}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={close}
        className="pressable rounded p-0.5 text-faint opacity-0 transition-opacity duration-100 hover:text-foreground focus-visible:opacity-100 group-hover/tab:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
})

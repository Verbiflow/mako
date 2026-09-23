import { harnessLabel } from "@/components/rail/harness-meta"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { ActivityMark, type ActivityState } from "@/components/ui/activity-mark"
import { ThreadActions } from "@/components/rail/thread-actions"
import { archivedLive, useThreadArchives } from "@/state/thread-lifecycle"
import { workspaceName } from "@/lib/format"
import { threadFolderKey } from "@/lib/thread-folders"
import { acp } from "@/state/acp"
import type { AcpPresence } from "@/state/acp-presence"
import { cn } from "@/lib/utils"

export function LiveAgentRow({
  presence,
  indent = false,
}: {
  presence: AcpPresence
  indent?: boolean
}) {
  const archived = useThreadArchives((state) => archivedLive(presence, state.keys))
  const label =
    presence.status === "needs-permission"
      ? "Needs your approval"
      : presence.status === "running"
        ? "Working"
        : presence.status === "starting"
          ? "Connecting"
          : presence.status === "failed"
            ? "Failed"
            : "Ready"
  const state: ActivityState =
    presence.status === "needs-permission"
      ? "waiting"
      : presence.status === "starting"
        ? "connecting"
        : presence.status === "running"
          ? "working"
          : presence.status === "failed"
            ? "failed"
            : "idle"
  const title =
    presence.title ?? `New ${harnessLabel(presence.harness)} conversation`
  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); acp.activate(presence.key) } }}
      aria-label={`${title}, ${label}`}
      data-thread-row
      data-flip-key={presence.key}
      data-conversation-id={presence.key}
      data-thread-indent={indent || undefined}
      onClick={() => acp.activate(presence.key)}
      className={cn(
        "pressable group relative flex h-8 w-full items-center gap-2 rounded-md pr-1.5 text-left transition-colors duration-100 hover:bg-fill-hover",
        indent ? "pl-[26px]" : "pl-1.5"
      )}
    >
      <HarnessIcon harness={presence.harness} className="size-3 shrink-0" />
      <span className="min-w-0 flex-[1_1_60%] truncate text-ui text-foreground/85">
        {title}
      </span>
      {!indent ? (
        <span className="min-w-10 max-w-[6rem] shrink truncate text-label text-faint">
          {threadFolderKey(presence) ? workspaceName(presence.cwd) : "tmp"}
        </span>
      ) : null}
      <span
        className="-my-1 hidden shrink-0 items-center group-hover:flex group-focus-within:flex group-focus-visible:flex has-[[data-state=open]]:flex"
        onClick={(event) => event.stopPropagation()}
      >
        <ThreadActions target={{ kind: "live", id: presence.key }} title={title} archived={archived} running={presence.status === "running" || presence.status === "starting" || presence.status === "needs-permission"} controlled path={presence.threadPath} />
      </span>
      <span title={label} className="flex shrink-0 text-muted-foreground">
        <ActivityMark state={state} size={20} />
      </span>
    </div>
  )
}

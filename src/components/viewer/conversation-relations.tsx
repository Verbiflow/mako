import { useHarnessIdentity } from "@/lib/harness-label"
import { ListTodoIcon, XIcon } from "lucide-react"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { acp, useAcp, activeLiveAcp } from "@/state/acp"
import { harnessLabel } from "@/components/rail/harness-meta"

const EMPTY_CHILDREN: never[] = []

/**
 * Where this conversation came from and what came back to it: the
 * conversation it forked from, fork findings waiting for the next turn, and
 * child tasks delegated before Delegate was retired.
 */
export function ConversationRelations() {
  useHarnessIdentity()
  const ancestry = useAcp((state) => activeLiveAcp(state)?.control?.ancestry)
  const pendingMerges = useAcp(
    (state) =>
      activeLiveAcp(state)?.control?.merges.filter(
        (merge) => merge.status === "pending"
      ).length ?? 0
  )
  const children = useAcp(
    (state) => activeLiveAcp(state)?.control?.children ?? EMPTY_CHILDREN
  )
  const hasTask = useAcp((state) =>
    Boolean(
      activeLiveAcp(state)?.requests?.some(
        (request) =>
          request.status === "completed" || request.status === "dispatching"
      )
    )
  )
  if (!ancestry && children.length === 0 && pendingMerges === 0) return null
  const label =
    children.length > 0
      ? `${children.length} delegated`
      : ancestry?.kind === "fork"
        ? "Forked"
        : ancestry
          ? "Delegated task"
          : "Fork findings"
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <ListTodoIcon className="size-3" />
          {label}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] w-[min(100vw_-_32px,480px)] overflow-y-auto p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <DialogTitle>Related conversations</DialogTitle>
          <DialogClose asChild>
            <button
              type="button"
              aria-label="Close related conversations"
              className="pressable rounded p-1 text-faint hover:bg-fill-hover hover:text-foreground"
            >
              <XIcon className="size-4" />
            </button>
          </DialogClose>
        </div>
        <div className="flex flex-col gap-3 text-ui text-muted-foreground">
          {ancestry ? (
            <button
              type="button"
              className="pressable mb-2 underline"
              onClick={() => void acp.openRelated(ancestry.parentId)}
            >
              Open original conversation
            </button>
          ) : null}
          {ancestry?.kind === "fork" && hasTask ? (
            <button
              type="button"
              className="pressable ml-3 underline"
              onClick={() => void acp.mergeFork()}
            >
              Return findings
            </button>
          ) : null}
          {pendingMerges > 0 ? (
            <p>
              {pendingMerges} fork results will be included in the next turn.
              Files are unchanged.
            </p>
          ) : null}
          {children.map((child) => (
            <div key={child.id} className="flex items-center gap-2 py-1">
              <button
                type="button"
                className="pressable min-w-0 flex-1 truncate text-left hover:text-foreground"
                onClick={() => void acp.openRelated(child.id)}
              >
                {child.task}
              </button>
              <span>
                {harnessLabel(child.provider)} · {child.status}
              </span>
              {child.delivery === "pending" || child.delivery === "queued" ? (
                <button
                  type="button"
                  className="pressable underline"
                  onClick={() => void acp.cancelChild(child.id)}
                >
                  Cancel
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

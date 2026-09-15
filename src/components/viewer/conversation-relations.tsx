import { useRef, useState } from "react"
import { ListTodoIcon, XIcon } from "lucide-react"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { SearchSelect } from "@/components/ui/search-select"
import { useDrafts, rememberDraft, clearSubmittedDraft } from "@/state/drafts"
import { acp, useAcp, activeLiveAcp } from "@/state/acp"
import { useThreads } from "@/state/threads"
import { liveHarnesses } from "@/state/descriptors"
import { harnessLabel } from "@/components/rail/harness-meta"

const EMPTY_CHILDREN: never[] = []
export function ConversationRelations() {
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
  const targets = useThreads((state) => liveHarnesses(state))
  const conversationId = useAcp((state) => state.activeKey ?? "")
  const draftKey = `delegation:${conversationId}`
  const task = useDrafts(
    (state) => state.drafts.find((draft) => draft.key === draftKey)?.text ?? ""
  )
  const setTask = (text: string) => rememberDraft(draftKey, text)
  const [provider, setProvider] = useState("")
  const [sending, setSending] = useState(false)
  const [open, setOpen] = useState(false)
  const taskInput = useRef<HTMLTextAreaElement>(null)
  if (!hasTask && !ancestry && children.length === 0) return null
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <ListTodoIcon className="size-3" />
          {children.length > 0 ? `${children.length} delegated` : "Delegate"}
        </button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[80vh] w-[min(100vw_-_32px,480px)] overflow-y-auto p-5"
        onOpenAutoFocus={(event) => {
          if (taskInput.current) {
            event.preventDefault()
            taskInput.current.focus()
          }
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <DialogTitle>
            {children.length > 0 || ancestry
              ? "Related tasks"
              : "Delegate a task"}
          </DialogTitle>
          <DialogClose asChild>
            <button
              type="button"
              aria-label="Close tasks"
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
          {hasTask && ancestry?.kind !== "delegation" ? (
            <section>
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  const submitted = task
                  if (!submitted.trim() || sending) return
                  setSending(true)
                  void acp
                    .delegate(provider || targets[0] || "", submitted)
                    .then((accepted) => {
                      if (accepted) clearSubmittedDraft(draftKey, submitted)
                    })
                    .finally(() => setSending(false))
                }}
              >
                <p className="text-label text-faint">
                  Run a focused task in a separate workspace. Findings return
                  here; file changes stay separate.
                </p>
                <SearchSelect
                  label="Task provider"
                  value={provider || targets[0] || ""}
                  options={targets.map((target) => ({
                    value: target,
                    label: harnessLabel(target),
                  }))}
                  onChange={setProvider}
                  className="self-start"
                />
                <label
                  htmlFor="delegated-task"
                  className="text-ui font-medium text-foreground"
                >
                  Task
                </label>
                <textarea
                  ref={taskInput}
                  id="delegated-task"
                  aria-label="Delegated task"
                  className="max-h-64 min-h-28 w-full resize-y rounded border border-hairline bg-surface p-2 text-ui"
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  placeholder="Describe the task and what a useful result should include"
                />
                <button
                  type="submit"
                  disabled={sending || !task.trim() || targets.length === 0}
                  className="pressable self-end rounded-md bg-foreground px-3 py-1.5 text-ui font-medium text-background disabled:opacity-40"
                >
                  {sending ? "Starting task…" : "Delegate task"}
                </button>
              </form>
            </section>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

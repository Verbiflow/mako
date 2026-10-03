import { useId, useRef, useState } from "react"
import { AppWindowIcon, CircleStopIcon, FolderIcon, GitBranchIcon, GitMergeIcon, InfoIcon, Trash2Icon } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Action } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import { useConfirm } from "@/state/confirm"

const icons = { remove: Trash2Icon, merge: GitMergeIcon, stop: CircleStopIcon }
const subjectIcons = { folder: FolderIcon, branch: GitBranchIcon, app: AppWindowIcon }

/** The one dialog `confirmAction` opens, mounted once beside the toaster. */
export function ConfirmHost() {
  const live = useConfirm((state) => state.request)
  const bodyId = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  const proceed = useRef<HTMLButtonElement>(null)
  // Answering clears the request at once; the closing dialog keeps showing what was asked.
  const [shown, setShown] = useState(live)
  if (live && live !== shown) setShown(live)
  const request = live ?? shown
  const negative = request?.tone === "negative"
  const Icon = request?.icon ? icons[request.icon] : null

  return (
    <Dialog open={Boolean(live)} onOpenChange={(open) => { if (!open) live?.answer(false) }}>
      <DialogContent
        className="w-[calc(100vw-32px)] max-w-dialog overflow-hidden"
        aria-describedby={bodyId}
        data-confirm-dialog=""
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const first = negative ? cancel : proceed
          first.current?.focus()
        }}
      >
        <div className="flex gap-3.5 px-5 pt-5">
          {Icon ? (
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg",
                negative ? "bg-negative/12 text-negative" : "bg-raised text-foreground ring-1 ring-hairline"
              )}
              aria-hidden
            >
              <Icon className="size-[18px]" strokeWidth={1.75} />
            </span>
          ) : null}
          <div className="min-w-0 flex-1 pt-px">
            <DialogTitle className="text-title">{request?.title}</DialogTitle>
            <p id={bodyId} className="mt-1 text-ui leading-relaxed text-muted-foreground">{request?.body}</p>
          </div>
        </div>
        {request?.subjects?.length ? (
          <ul className="mx-5 mt-4 overflow-hidden rounded-lg bg-surface ring-1 ring-hairline">
            {request.subjects.map((subject) => {
              const SubjectIcon = subjectIcons[subject.kind]
              return (
                <li key={`${subject.kind}:${subject.name}`} className="flex h-9 items-center gap-2.5 border-b border-hairline px-3 last:border-0">
                  <SubjectIcon className="size-3.5 shrink-0 text-faint" aria-label={subject.kind} />
                  <span className={cn("min-w-0 flex-1 truncate text-label text-foreground/90", subject.kind !== "app" && "font-mono")} title={subject.name}>{subject.name}</span>
                  {subject.detail ? (
                    <span className={cn("shrink-0 text-label", subject.lost ? "text-negative" : "text-faint")}>{subject.detail}</span>
                  ) : null}
                </li>
              )
            })}
            {request.more ? (
              <li className="flex h-9 items-center px-3 text-label text-faint">And {request.more} more</li>
            ) : null}
          </ul>
        ) : null}
        {request?.note ? (
          <p className="mx-5 mt-3 flex gap-2 text-label leading-relaxed text-faint">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {request.note}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2 border-t border-hairline bg-surface px-4 py-3">
          <Action ref={cancel} size="md" tone="quiet" data-confirm-cancel="" onClick={() => live?.answer(false)}>
            Cancel
          </Action>
          <Action
            ref={proceed}
            size="md"
            data-confirm-action=""
            onClick={() => live?.answer(true)}
            className={cn("px-3", negative ? "bg-negative text-background hover:not-disabled:opacity-90" : "bg-primary text-primary-foreground hover:not-disabled:opacity-90")}
          >
            {request?.confirm}
          </Action>
        </div>
      </DialogContent>
    </Dialog>
  )
}

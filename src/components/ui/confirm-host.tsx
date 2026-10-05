import { useId, useRef, useState } from "react"
import { AppWindowIcon, CircleStopIcon, FileIcon, FolderIcon, GitBranchIcon, GitMergeIcon, InfoIcon, Trash2Icon } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Action } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import { useConfirm } from "@/state/confirm"
import { PathLabel } from "@/components/ui/path-label"

const icons = { remove: Trash2Icon, merge: GitMergeIcon, stop: CircleStopIcon }
const subjectIcons = { folder: FolderIcon, branch: GitBranchIcon, app: AppWindowIcon, file: FileIcon }

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
        <div className="flex gap-3 px-5 pt-5">
          {Icon ? (
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06]",
                negative ? "text-negative/90" : "text-muted-foreground"
              )}
              aria-hidden
            >
              <Icon className="size-4" strokeWidth={1.75} />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-title leading-8">{request?.title}</DialogTitle>
            <p id={bodyId} className="text-ui leading-relaxed text-muted-foreground">{request?.body}</p>
          </div>
        </div>
        {request?.subjects?.length ? (
          <ul className="mx-5 mt-4 overflow-hidden rounded-lg bg-foreground/[0.03] py-1 ring-1 ring-hairline">
            {request.subjects.map((subject) => {
              const SubjectIcon = subjectIcons[subject.kind]
              return (
                <li key={`${subject.kind}:${subject.name}`} className="flex h-8 items-center gap-2.5 px-3">
                  <SubjectIcon className="size-3.5 shrink-0 text-faint" aria-label={subject.kind} />
                  {subject.kind === "file" ? <PathLabel path={subject.name} className="flex-1" nameClassName="text-foreground/90" /> :
                  <span className={cn("min-w-0 flex-1 truncate text-label text-foreground/90", subject.kind !== "app" && "font-mono")} title={subject.name}>{subject.name}</span>}
                  {subject.detail ? (
                    <span className={cn("shrink-0 text-label", subject.lost ? "text-negative/85" : "text-faint")}>{subject.detail}</span>
                  ) : null}
                </li>
              )
            })}
            {request.more ? (
              <li className="flex h-8 items-center px-3 pl-9 text-label text-faint">And {request.more} more</li>
            ) : null}
          </ul>
        ) : null}
        {request?.note ? (
          <p className="mx-5 mt-3 flex gap-2 text-label leading-relaxed text-faint">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {request.note}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2 px-5 pb-5">
          <Action ref={cancel} size="sm" tone="quiet" data-confirm-cancel="" onClick={() => live?.answer(false)}>
            Cancel
          </Action>
          <Action
            ref={proceed}
            size="sm"
            data-confirm-action=""
            onClick={() => live?.answer(true)}
            className={cn("px-3", negative ? "bg-negative/15 text-negative hover:not-disabled:bg-negative/25" : "bg-primary text-primary-foreground hover:not-disabled:opacity-90")}
          >
            {request?.confirm}
          </Action>
        </div>
      </DialogContent>
    </Dialog>
  )
}

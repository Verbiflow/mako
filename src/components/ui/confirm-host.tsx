import { useId, useState, type KeyboardEvent } from "react"
import { AppWindowIcon, CircleStopIcon, FileIcon, FolderIcon, GitBranchIcon, GitMergeIcon, InfoIcon, MessageSquareIcon, Trash2Icon } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useConfirm } from "@/state/confirm"
import { PathLabel } from "@/components/ui/path-label"

const icons = { remove: Trash2Icon, merge: GitMergeIcon, stop: CircleStopIcon }
const subjectIcons = { folder: FolderIcon, branch: GitBranchIcon, app: AppWindowIcon, session: MessageSquareIcon, file: FileIcon }
const proseSubjects: ReadonlySet<string> = new Set(["app", "session"])

/** Both answers share one box, so neither reads heavier than the other. */
const answer = "pressable inline-flex h-7 min-w-18 items-center justify-center border px-3 text-ui font-medium transition-colors duration-100 focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-ring"

/** The one dialog `confirmAction` opens, mounted once beside the toaster. */
export function ConfirmHost() {
  const live = useConfirm((state) => state.request)
  const bodyId = useId()
  // Answering clears the request at once; the closing dialog keeps showing what was asked.
  const [shown, setShown] = useState(live)
  if (live && live !== shown) setShown(live)
  const request = live ?? shown
  const negative = request?.tone === "negative"
  const Icon = request?.icon ? icons[request.icon] : null
  // Enter answers yes only when yes loses nothing; a destructive answer takes a click or Tab.
  const keys = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || negative || event.target !== event.currentTarget) return
    event.preventDefault()
    live?.answer(true)
  }

  return (
    <Dialog open={Boolean(live)} onOpenChange={(open) => { if (!open) live?.answer(false) }}>
      <DialogContent
        className="w-[calc(100vw-32px)] max-w-dialog overflow-hidden"
        aria-describedby={bodyId}
        data-confirm-dialog=""
        data-corners="square"
        tabIndex={-1}
        onKeyDown={keys}
        onOpenAutoFocus={(event) => {
          // The dialog takes focus itself: a ring on either answer before anyone pressed a key reads as a choice made for them.
          event.preventDefault()
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
        }}
      >
        <div className="flex gap-2.5 px-5 pt-4.5">
          {Icon ? <Icon className={cn("mt-1 size-4 shrink-0", negative ? "text-negative/90" : "text-muted-foreground")} strokeWidth={1.75} aria-hidden /> : null}
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-title leading-6">{request?.title}</DialogTitle>
            <p id={bodyId} className="mt-0.5 text-ui leading-relaxed text-muted-foreground">{request?.body}</p>
          </div>
        </div>
        {request?.subjects?.length ? (
          <ul className="mx-5 mt-3.5 divide-y divide-hairline border border-hairline bg-foreground/[0.025]">
            {request.subjects.map((subject) => {
              const SubjectIcon = subjectIcons[subject.kind]
              return (
                <li key={`${subject.kind}:${subject.id ?? subject.name}`} className="flex h-8 items-center gap-2.5 px-3">
                  <SubjectIcon className="size-3.5 shrink-0 text-faint" aria-label={subject.kind} />
                  {subject.kind === "file" ? <PathLabel path={subject.name} className="flex-1" nameClassName="text-foreground/90" /> :
                  <span className={cn("min-w-0 flex-1 truncate text-label text-foreground/90", !proseSubjects.has(subject.kind) && "font-mono")} title={subject.name}>{subject.name}</span>}
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
          <p className="mx-5 mt-2.5 flex gap-2 text-label leading-relaxed text-faint">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {request.note}
          </p>
        ) : null}
        <div className="mt-4.5 flex justify-end gap-2 border-t border-hairline px-5 py-3">
          <button
            type="button"
            data-confirm-cancel=""
            onClick={() => live?.answer(false)}
            className={cn(answer, "border-hairline text-foreground/85 hover:bg-fill-hover hover:text-foreground")}
          >
            Cancel
          </button>
          <button
            type="button"
            data-confirm-action=""
            onClick={() => live?.answer(true)}
            className={cn(
              answer,
              negative
                ? "border-negative/30 bg-negative/12 text-negative hover:bg-negative/20"
                : "border-transparent bg-primary text-primary-foreground hover:opacity-90"
            )}
          >
            {request?.confirm}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

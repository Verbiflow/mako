import { useRef, useState, type ReactNode, type RefObject } from "react"
import type { ProposedPlan } from "@mako/sessions/content"
import { CheckIcon, CopyIcon, MoreHorizontalIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { IconAction } from "@/components/ui/kit"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useCopy } from "@/components/ui/use-copy"
import { proposedPlanFilename, proposedPlanMarkdown } from "@/lib/proposed-plan"
import { downloadPlan, savePlan } from "@/state/plans"
import type { PlanState } from "./plan-state"

export function CopyPlanAction({ plan, size = "xs" }: { plan: ProposedPlan; size?: "xs" | "sm" }) {
  const { copied, copy } = useCopy(proposedPlanMarkdown(plan))
  return (
    <IconAction label={copied ? "Copied" : "Copy as Markdown"} size={size} onClick={() => void copy()}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconAction>
  )
}

/** Download, save into the workspace, and the builds that aren't the plan's main action. */
export function PlanMenu({
  plan,
  state,
  onBuild,
  building,
  size = "xs",
  children,
}: {
  plan: ProposedPlan
  state: PlanState
  onBuild: (where: "here" | "new") => void
  building: boolean
  size?: "xs" | "sm"
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const focus = useWorkspaceFocus()
  const item = "pressable block w-full rounded px-2 py-1.5 text-left text-ui hover:bg-fill-hover disabled:opacity-40"
  const close = (then: () => void) => () => {
    setOpen(false)
    then()
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <IconAction ref={trigger} label="More plan actions" size={size}>
            <MoreHorizontalIcon />
          </IconAction>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 p-1">
          {children}
          <button type="button" className={item} onClick={close(() => downloadPlan(plan))}>
            Download Markdown
          </button>
          <button type="button" className={item} disabled={!focus.cwd || !focus.ready} onClick={close(() => setSaving(true))}>
            Save to workspace…
          </button>
          {state.built && !state.superseded ? (
            <button type="button" className={item} disabled={!state.ready || building} onClick={close(() => onBuild("here"))}>
              Build again in this session
            </button>
          ) : null}
          {state.superseded ? (
            <button
              type="button"
              className={item}
              disabled={!state.ready || building}
              title="Earlier revisions build only in a new session; this one keeps the newer plan"
              onClick={close(() => onBuild("new"))}
            >
              Build this revision in a new session
            </button>
          ) : null}
        </PopoverContent>
      </Popover>
      <SavePlanDialog plan={plan} open={saving} onOpenChange={setSaving} returnFocus={trigger} />
    </>
  )
}

function SavePlanDialog({
  plan,
  open,
  onOpenChange,
  returnFocus,
}: {
  plan: ProposedPlan
  open: boolean
  onOpenChange: (open: boolean) => void
  returnFocus: RefObject<HTMLButtonElement | null>
}) {
  const focus = useWorkspaceFocus()
  const [path, setPath] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const input = useRef<HTMLInputElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(100vw_-_32px,440px)] p-5"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          returnFocus.current?.focus()
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          setPath(proposedPlanFilename(plan.text))
          setError("")
          requestAnimationFrame(() => {
            input.current?.focus()
            input.current?.select()
          })
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <DialogTitle>Save plan to workspace</DialogTitle>
          <DialogClose asChild>
            <button type="button" aria-label="Close save plan" className="pressable rounded p-1 text-faint hover:bg-fill-hover">
              <XIcon className="size-4" />
            </button>
          </DialogClose>
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!focus.cwd || !path.trim() || saving) return
            setSaving(true)
            setError("")
            void savePlan(focus.cwd, path, plan)
              .then((saved) => {
                onOpenChange(false)
                toast.success("Plan saved", { description: saved })
              })
              .catch((failure) => setError(failure instanceof Error ? failure.message : "The plan could not be saved."))
              .finally(() => setSaving(false))
          }}
        >
          <label className="flex flex-col gap-2 text-ui">
            New Markdown file
            <input
              ref={input}
              aria-label="Plan file path"
              className="rounded-md border border-hairline bg-surface px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <p className="text-label break-all text-faint">In {focus.cwd}</p>
          {error ? (
            <p role="alert" className="text-ui text-negative">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={!path.trim() || saving}
            className="pressable self-end rounded-md border border-hairline px-3 py-2 text-ui hover:bg-fill-hover disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save plan"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

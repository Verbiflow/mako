import { LoaderCircleIcon, SquareDashedMousePointerIcon, XIcon } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type { ComposerControlSlotProps } from "@/extend/slots"
import { elementPicks, useElementPicks } from "@/state/element-picks"
import { useSession } from "@/state/session"
import { ElementPickChooser } from "./element-pick-chooser"

/**
 * "Pick an element…" in the composer's + menu. The + menu closes and the
 * chooser opens as its own dialog, the one the palette opens: a popover
 * inside the + menu's popover drew over it, both half visible.
 */
export function ElementPickButton({ disabled, dismiss }: ComposerControlSlotProps) {
  const active = useElementPicks((state) => state.active)
  return (
    <button
      type="button"
      aria-label="Pick an element in the browser"
      className="pressable flex min-h-9 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-ui text-foreground hover:bg-fill-hover focus-visible:bg-fill-hover disabled:opacity-40"
      disabled={disabled}
      onClick={() => {
        dismiss?.()
        // The + menu's close moves focus; the dialog opens after it.
        requestAnimationFrame(() => elementPicks.choose(true))
      }}
    >
      {active ? (
        <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
      ) : (
        <SquareDashedMousePointerIcon className="size-4 text-muted-foreground" />
      )}
      {active ? `Picking in ${active.place}…` : "Pick an element…"}
    </button>
  )
}

/** One line above the composer while a pick runs in a browser tab, with the way to end it from here. */
export function ElementPickNotice() {
  const active = useElementPicks((state) => state.active)
  if (!active) return null
  return (
    <div role="status" className="mb-1.5 flex items-center gap-2 rounded-md bg-raised px-2 py-1 text-ui text-muted-foreground">
      <SquareDashedMousePointerIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {active.starting ? `Opening the picker in ${active.place}…` : `Point at an element in ${active.place}, then add it there`}
      </span>
      <button
        type="button"
        onClick={() => elementPicks.cancel()}
        className="pressable flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-label font-medium text-foreground hover:bg-fill-hover"
      >
        <XIcon className="size-3" aria-hidden />
        Cancel
      </button>
    </div>
  )
}

/**
 * The chooser the palette's "Pick an element in the browser" opens, outside
 * any composer menu. Registered once per window (on `titlebar.trailing`, where
 * it draws nothing until it opens), so the palette has one dialog to open.
 */
export function ElementPickDialog() {
  const choosing = useElementPicks((state) => state.choosing)
  const cwd = useSession((state) => state.meta?.cwd)
  return (
    <Dialog open={choosing} onOpenChange={(open) => elementPicks.choose(open)}>
      <DialogContent className="w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden p-0">
        <DialogTitle className="sr-only">Pick an element</DialogTitle>
        <ElementPickChooser cwd={cwd} onChosen={() => elementPicks.choose(false)} />
      </DialogContent>
    </Dialog>
  )
}

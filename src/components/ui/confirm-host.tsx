import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useConfirm } from "@/state/confirm"

/** The one dialog `confirmAction` opens, mounted once beside the toaster. */
export function ConfirmHost() {
  const request = useConfirm((state) => state.request)
  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open) request?.answer(false) }}>
      <DialogContent className="max-w-sm p-5" data-confirm-dialog="">
        <DialogTitle>{request?.title}</DialogTitle>
        <p className="mt-2 text-ui text-muted-foreground">{request?.body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={() => request?.answer(false)}
            className="pressable rounded-md px-3 py-1.5 text-ui hover:bg-fill-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            data-confirm-action=""
            onClick={() => request?.answer(true)}
            className={cn(
              "pressable rounded-md px-3 py-1.5 text-ui",
              request?.tone === "negative"
                ? "bg-negative/15 text-negative hover:bg-negative/25"
                : "bg-fill-selected text-foreground hover:bg-fill-hover",
            )}
          >
            {request?.confirm}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

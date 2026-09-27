import type { CheckoutHead } from "../../../electron/contracts/checkout-heads.ts"
import { checkoutLabel } from "@/state/checkout-heads"
import { cn } from "@/lib/utils"

/** A checkout's head as a few words: its branch, the branch a rebase is replaying, or a short commit. */
export function CheckoutLabel({ head, className }: { head: CheckoutHead; className?: string }) {
  return (
    <span className={cn("truncate", className)}>
      {head.kind === "rebasing" ? <span className="text-caution">Rebasing </span> : null}
      {head.kind === "detached" ? <span className="font-mono">{checkoutLabel(head)}</span> : head.name}
    </span>
  )
}
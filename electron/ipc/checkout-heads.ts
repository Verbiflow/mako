import type { MethodTable } from "@mako/host/base/methods"
import type { CheckoutHeadService } from "../checkout-heads.js"
import type { CheckoutHeads } from "@mako/host/contracts/checkout-heads"

/** More folders than a rail shows; a longer list is a caller bug, not a bigger answer. */
const MAX_FOLDERS = 200

/** Each folder's checkout head, followed from then on; changes arrive as `checkout-heads` events. */
export function installCheckoutHeadsIpc(methods: MethodTable, heads: CheckoutHeadService) {
  methods.handle("mako:checkout-heads", (folders: string[]): Promise<CheckoutHeads> => {
    if (folders.length > MAX_FOLDERS) throw new Error(`Ask for at most ${MAX_FOLDERS} folders at once.`)
    return heads.read(folders)
  })
}

/** What a Git checkout has checked out, read from its HEAD. */
export type CheckoutHead =
  | { kind: "branch"; name: string }
  /** A rebase is replaying commits onto `name`; HEAD itself is detached meanwhile. */
  | { kind: "rebasing"; name: string }
  | { kind: "detached"; commit: string }

/** By folder, the head of the checkout it is in; null for a folder in no checkout. */
export type CheckoutHeads = Record<string, CheckoutHead | null>

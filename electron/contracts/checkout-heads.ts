/** A linked worktree (what `git worktree add` makes): its top folder, and the main checkout it belongs to. */
export interface LinkedCheckout {
  path: string
  repoRoot: string
}

/** What a Git checkout has checked out, read from its HEAD; `linked` when the checkout is a linked worktree. */
export type CheckoutHead = (
  | { kind: "branch"; name: string }
  /** A rebase is replaying commits onto `name`; HEAD itself is detached meanwhile. */
  | { kind: "rebasing"; name: string }
  | { kind: "detached"; commit: string }
) & { linked?: LinkedCheckout }

/** By folder, the head of the checkout it is in; null for a folder in no checkout. */
export type CheckoutHeads = Record<string, CheckoutHead | null>

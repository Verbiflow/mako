/**
 * How long a toast stays. Receipts take the Toaster's default (three
 * seconds); a toast that offers an action — Retry, Refresh changes, Open —
 * stays long enough to read and act on, then leaves like everything else.
 * Nothing is permanent: a toast that never closed once sat in the corner for
 * a whole session, and the state it reported is recorded where it belongs —
 * the transcript, the thread's mark, the Changes panel.
 * `scripts/check-actionable-toasts.mjs` enforces both halves.
 */
export const ACTION_TOAST_MS = 8000

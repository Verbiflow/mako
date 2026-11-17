/** Exact older host refusals, retained only for reading legacy failure evidence. */
export const NATIVE_VERIFICATION_REASONS = {
  service: "The runtime could not verify the reopened native service authority. No prompt was dispatched.",
  identity: "The runtime could not verify the reopened account's native identity. Retry after sign-in is available; the saved conversation was preserved.",
  account: "The runtime could not verify the reopened account selection. No prompt was dispatched.",
} as const
export const NATIVE_VERIFICATION_WAITING = "The session's native verification is temporarily unavailable. Mako will check it again before sending."
export function nativeVerificationPending(message: string): boolean {
  return message === NATIVE_VERIFICATION_WAITING || Object.values(NATIVE_VERIFICATION_REASONS).some(reason => reason === message)
}

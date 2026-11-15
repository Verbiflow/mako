/** Native evidence that was previously known must be read again before a reopened process takes input. */
export const NATIVE_VERIFICATION_REASONS = {
  service: "The runtime could not verify the reopened native service authority. No prompt was dispatched.",
  identity: "The runtime could not verify the reopened account's native identity. Retry after sign-in is available; the saved conversation was preserved.",
  account: "The runtime could not verify the reopened account selection. No prompt was dispatched.",
} as const

const WAITING = "The session's native verification is temporarily unavailable. Mako will check it again before sending."

/** The exact host refusals, including their older wording; never a classifier of arbitrary provider prose. */
export function nativeVerificationPending(message: string): boolean {
  return message === WAITING || Object.values(NATIVE_VERIFICATION_REASONS).some((reason) => reason === message)
}

/** No prompt was admitted. A later attempt must obtain new evidence, not treat the failed read as permission. */
export class NativeVerificationPendingError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super(WAITING)
    this.name = "NativeVerificationPendingError"
    this.detail = detail
  }
}

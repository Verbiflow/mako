import { HostFailureError } from "./provider-failure.js"
import { NATIVE_VERIFICATION_WAITING } from "./native-verification-message.js"
export { NATIVE_VERIFICATION_REASONS, nativeVerificationPending } from "./native-verification-message.js"

/** No prompt was admitted. A later attempt must obtain new evidence, not treat the failed read as permission. */
export class NativeVerificationPendingError extends HostFailureError {
  readonly detail: string
  /** The check only ran out of time and found nothing against the session: it is asked again soon (`QUICK_RETRY_MS`). */
  readonly soon: boolean

  constructor(detail: string, soon = false) {
    super("launch-stalled", NATIVE_VERIFICATION_WAITING)
    this.name = "NativeVerificationPendingError"
    this.detail = detail
    this.soon = soon
  }
}

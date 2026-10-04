export type UtilityErrorKind =
  "context" | "auth" | "rate-limit" | "timeout" | "output" | "request"

/** A model's refusal or failure, with a message safe to show and log. */
export class UtilityModelError extends Error {
  readonly kind: UtilityErrorKind

  constructor(kind: UtilityErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = "UtilityModelError"
  }
}

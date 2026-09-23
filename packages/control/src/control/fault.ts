import { z } from "zod"
export const ControlFaultSchema = z.object({
  code: z.string().min(1),
  outcome: z.enum(["not-dispatched", "rejected", "unknown"]),
})
export type ControlFaultData = z.infer<typeof ControlFaultSchema>
export class ControlFault extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: ControlFaultData["outcome"]
  ) {
    super(message)
    this.name = "ControlFault"
  }
}
export function controlFaultData(cause: unknown): ControlFaultData | undefined {
  const direct = ControlFaultSchema.safeParse(cause)
  if (direct.success) return direct.data
  const wrapped = z.object({ detail: ControlFaultSchema }).safeParse(cause)
  return wrapped.success ? wrapped.data.detail : undefined
}

/** Only for caller input, before dispatch. Never use for a backend response. */
export function controlInput<T>(
  result: z.ZodSafeParseResult<T>,
  operation: string,
  hint: string
): T {
  if (result.success) return result.data
  throw new ControlFault(
    "invalid-request",
    controlInputMessage(result.error, operation, hint),
    "not-dispatched"
  )
}

/** Bounded diagnostics describe fields, never serialize the submitted payload. */
export function controlInputMessage(
  error: z.ZodError,
  operation: string,
  hint: string
): string {
  const issues = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.map(String).join(".").slice(0, 100) || "input"
    const detail =
      issue.code === "unrecognized_keys"
        ? `Unknown fields: ${issue.keys
            .slice(0, 3)
            .map((key) => JSON.stringify(key.slice(0, 60)))
            .join(", ")}`
        : issue.message.replace(/\s+/g, " ").slice(0, 220)
    return `${path}: ${detail}`
  })
  return `Invalid ${operation}. ${issues.join("; ")}. ${hint}`
}

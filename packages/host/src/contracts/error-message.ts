import { z } from "zod"

/** Where a failure was caught, with what was thrown. */
export interface FailureBoundary {
  error: unknown
}

const RpcErrorSchema = z
  .object({
    data: z
      .object({ message: z.string().optional(), details: z.string().optional() })
      .loose()
      .optional(),
  })
  .loose()

/** A rejection that is not an Error but says what went wrong, as OpenCode's tagged errors do. */
const ThrownMessageSchema = z.object({ message: z.string().min(1) })

/**
 * What went wrong, in words. A JSON-RPC error carries its reason in `data`,
 * not in `message`: Cursor answers `session/set_config_option` with "Invalid
 * params" and puts "Unknown model config option: effort" beside it. Dropping
 * that once left two failed threads explained by nothing more than the
 * generic code text.
 */
export function errorMessage({ error }: FailureBoundary): string {
  if (!(error instanceof Error)) return ThrownMessageSchema.safeParse(error).data?.message ?? String(error)
  // `data` is an own enumerable property on a JSON-RPC RequestError; the
  // Error prototype's own fields are not, so the entries are exactly the extras.
  const parsed = RpcErrorSchema.safeParse(Object.fromEntries(Object.entries(error)))
  const reason = parsed.success ? (parsed.data.data?.message ?? parsed.data.data?.details) : undefined
  if (!reason || !error.message || error.message.includes(reason)) return error.message || (reason ?? String(error))
  return `${error.message}: ${reason}`
}

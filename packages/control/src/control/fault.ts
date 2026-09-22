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

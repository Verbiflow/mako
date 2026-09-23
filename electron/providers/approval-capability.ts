import { z } from "zod"

/** Evidence implemented by this adapter, not a claim about every native version. */
export const ApprovalEvidenceCapabilitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("native-decisions"),
    recovery: z.enum(["retained-observer", "live-only"]),
    coverage: z.string().trim().min(1),
  }),
  z.object({ kind: z.literal("request-lifecycle"), reason: z.string().trim().min(1) }),
  z.object({ kind: z.literal("submission-only"), reason: z.string().trim().min(1) }),
  z.object({ kind: z.literal("no-interactive-requests"), reason: z.string().trim().min(1) }),
])
export type ApprovalEvidenceCapability = z.infer<typeof ApprovalEvidenceCapabilitySchema>

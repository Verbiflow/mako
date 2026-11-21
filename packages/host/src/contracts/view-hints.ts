import { z } from "zod"

export const ViewDomainSchema = z.enum(["apps", "sync", "output"])
export type ViewDomain = z.infer<typeof ViewDomainSchema>

/** Hints invalidate projections; they never supply content or authorize a read. Unknown fields mean changed. */
export const ViewHintSchema = z.lazy(() => z.object({
  epoch: z.string().uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  domain: ViewDomainSchema,
  keys: z.array(z.string().max(4096)).max(256).optional(),
  fields: z.array(z.string().max(80)).max(32),
}).strict())
export type ViewHint = z.infer<typeof ViewHintSchema>

export const ViewHintsStatusSchema = z.lazy(() => z.object({
  version: z.literal(1),
  epoch: z.string().uuid(),
  domains: z.array(ViewDomainSchema),
}).strict())
export type ViewHintsStatus = z.infer<typeof ViewHintsStatusSchema>

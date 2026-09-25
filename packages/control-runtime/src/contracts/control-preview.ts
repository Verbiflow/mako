import { z } from "zod"
import { AppshotTargetSchema } from "./appshots.js"

export const ControlImageSchema = z.object({
  data: z.string().max(8 * 1024 * 1024),
  mimeType: z.enum(["image/png", "image/jpeg"]),
})
export const ComputerObservationSchema = z
  .object({
    operation: z.string().min(1).max(100),
    target: z.string().max(200),
    status: z.enum(["running", "observed", "error"]),
    image: ControlImageSchema.optional(),
    window: AppshotTargetSchema.optional(),
  })
  .strict()
export type ControlImage = z.infer<typeof ControlImageSchema>
export const ControlActivitySchema = z.object({
  conversationId: z.string().max(1024),
  kind: z.enum(["browser", "computer"]),
  operation: z.string().max(1024),
  target: z.string().max(4096),
  status: z.enum(["running", "observed", "error"]),
  updatedAt: z.number(),
})
export type ControlActivity = z.infer<typeof ControlActivitySchema>
export const ControlPreviewSchema = z.object({
  activity: ControlActivitySchema,
  window: AppshotTargetSchema.optional(),
  frame: z.object({
    id: z.string().max(128),
    image: z.object({
      bytes: z.custom<Uint8Array<ArrayBuffer>>(bytes => bytes instanceof Uint8Array &&
        bytes.buffer instanceof ArrayBuffer && bytes.byteLength > 0 && bytes.byteLength <= 2 * 1024 * 1024),
      mimeType: z.enum(["image/png", "image/jpeg"]),
    }),
    capturedAt: z.number(),
    /** Host publication is separate from the source's epoch timestamp. */
    publishedAt: z.number().optional(),
  }).nullable(),
})
export type ControlPreview = z.infer<typeof ControlPreviewSchema>

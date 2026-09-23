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
export interface ControlActivity {
  conversationId: string
  kind: "browser" | "computer"
  operation: string
  target: string
  status: "running" | "observed" | "error"
  updatedAt: number
}
export interface ControlPreview {
  activity: ControlActivity
  window?: import("./appshots.js").AppshotTarget
  frame: { id: string; image: ControlImage; capturedAt: number } | null
}

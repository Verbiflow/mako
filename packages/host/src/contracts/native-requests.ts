import { z } from "zod"
import { ThreadRefSchema } from "@mako/sessions/thread-schema"
import {
  PromptAttachmentSchema,
  ProviderSelectionSchema,
} from "./conversation-control.js"

export const NativeRequestInputSchema = z.object({
  id: z.string().uuid(),
  path: z.string().min(1),
  text: z.string().max(1_000_000),
  attachments: z.array(PromptAttachmentSchema).max(100),
  tuning: ProviderSelectionSchema.optional(),
})
export type NativeRequestInput = z.infer<typeof NativeRequestInputSchema>
export const NativeRequestSchema = z.object({
  input: NativeRequestInputSchema,
  ref: ThreadRefSchema,
  status: z.enum([
    "queued",
    "held",
    "dispatching",
    "completed",
    "failed",
    "uncertain",
    "dismissed",
  ]),
  error: z.string().optional(),
})
export type NativeRequest = z.infer<typeof NativeRequestSchema>

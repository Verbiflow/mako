import { z } from "zod"

export const PromptAttachmentSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  size: z.number().nonnegative().optional(),
  data: z.string().optional(),
  path: z.string().optional(),
})

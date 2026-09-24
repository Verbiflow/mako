import { z } from "zod"

export const DesktopSessionConfigSchema = z
  .object({
    taskId: z.string().min(1),
    native: z
      .object({ driver: z.string(), socket: z.string() })
      .strict()
      .optional(),
    browser: z
      .object({ url: z.string(), token: z.string() })
      .strict()
      .optional(),
    artifacts: z.string().optional(),
  })
  .strict()
export type DesktopSessionConfig = z.infer<typeof DesktopSessionConfigSchema>

export const DesktopSessionMessageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("start"),
      config: DesktopSessionConfigSchema,
      directory: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("stop") }).strict(),
])

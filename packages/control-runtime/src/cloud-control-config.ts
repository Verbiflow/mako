import { isAbsolute } from "node:path"
import { z } from "zod"

const executable = z
  .string()
  .min(1)
  .refine(isAbsolute, "Use an absolute executable path")
/** Trusted launcher configuration, never an agent tool argument. */
export const CloudControlConfigSchema = z
  .object({
    output: z
      .string()
      .min(1)
      .refine(isAbsolute, "Use an absolute output directory"),
    native: z.object({ driver: executable }).strict().optional(),
    browser: z
      .object({
        executable,
        sandbox: z.boolean().default(true),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(1000).max(86_400_000).default(3_600_000),
    startupMs: z.number().int().min(1000).max(120_000).default(30_000),
    shutdownMs: z.number().int().min(1000).max(120_000).default(30_000),
  })
  .strict()
  .refine(
    (value) => value.native || value.browser,
    "Select a native or browser backend"
  )
export type CloudControlConfig = z.infer<typeof CloudControlConfigSchema>

export const CloudWorkerMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("start"),
    config: CloudControlConfigSchema,
    runtime: z.string(),
  }),
  z.object({ kind: z.literal("stop"), reason: z.string() }),
])
export const CloudParentMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({
    kind: z.literal("finished"),
    clean: z.boolean(),
    reason: z.string(),
  }),
])

export type CloudParentMessage = z.infer<typeof CloudParentMessageSchema>

import { z } from "zod"

export const CodexInitializeSchema = z.object({
  userAgent: z.string().optional(),
  codexHome: z.string().optional(),
})
export type CodexInitialize = z.infer<typeof CodexInitializeSchema>

/** Parsed against installed Codex app-server 0.159.3's generate-ts protocol.
 * Retain only public identity fields, never credential or routing payloads. */
export const CodexIdentityResponseSchema = z.object({
  account: z.union([
    z.object({ type: z.literal("chatgpt"), email: z.string().nullable(), planType: z.string() }),
    z.object({ type: z.literal("apiKey") }),
    z.object({ type: z.literal("amazonBedrock"), usesCodexManagedCredentials: z.boolean() }),
  ]).nullable(),
  requiresOpenaiAuth: z.boolean(),
})
export type CodexIdentityResponse = z.infer<typeof CodexIdentityResponseSchema>

import { z } from "zod"
import type { ProviderAcpSource } from "../acp-source.js"

const inference = z.object({
  "cognition.ai/inferenceToolName": z.string().trim().min(1).max(512).optional(),
})

/** ACP kind describes the action; Devin metadata identifies the native tool. */
export const devinToolName: NonNullable<ProviderAcpSource["toolName"]> = (tool) => {
  const parsed = inference.safeParse(tool._meta)
  return parsed.success ? parsed.data["cognition.ai/inferenceToolName"] : undefined
}

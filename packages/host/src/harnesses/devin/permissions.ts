import type { RequestPermissionRequest } from "@agentclientprotocol/sdk"
import { z } from "zod"

const commandMetadata = z.object({
  "cognition.ai/editableCommand": z.string().trim().min(1).max(8192).optional(),
})

/** Devin omits the ACP title but supplies the shell command in native metadata. */
export function devinPermissionTitle(request: RequestPermissionRequest) {
  const metadata = commandMetadata.safeParse(request.toolCall._meta)
  const command = metadata.success ? metadata.data["cognition.ai/editableCommand"] : undefined
  if (command) return command
  // MCP requests instead name the individual tool in their session-choice label.
  const choice = request.options.find(
    (option) => option.optionId === "allow_session"
  )
  const match = choice?.name.match(
    /^Yes, allow calling ([a-zA-Z0-9_.:-]+) on the ([a-zA-Z0-9_.:-]+) MCP server \(this session\)$/
  )
  return match?.[1] && match[2] ? `${match[2]}: ${match[1]}` : undefined
}

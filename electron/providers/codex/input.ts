import { appendPromptAttachments } from "@mako/sessions/prompt-attachments"
import type { PromptAttachment } from "../../shared.js"
import type { UserInput } from "./generated/v2/UserInput.js"

export function codexInput(
  text: string,
  attachments: PromptAttachment[]
): UserInput[] {
  const input: UserInput[] = [{ type: "text", text, text_elements: [] }]
  for (const attachment of attachments) {
    if (!attachment.path)
      throw new Error(`Attachment ${attachment.name} was not staged`)
    if (attachment.mimeType.startsWith("image/"))
      input.push({ type: "localImage", path: attachment.path })
    else
      input.push({
        type: "text",
        text: appendPromptAttachments("", [{ name: attachment.name, mimeType: attachment.mimeType, path: attachment.path }]),
        text_elements: [],
      })
  }
  return input
}

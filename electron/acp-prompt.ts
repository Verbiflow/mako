import { pathToFileURL } from "node:url"
import type { ContentBlock, PromptCapabilities } from "@agentclientprotocol/sdk"
import type { PromptAttachment } from "./contracts/providers-acp.js"

/** A prompt as ACP content: an image inline where the agent reads images, any other staged file as a link to it. */
export function acpPromptBlocks(text: string, attachments: readonly PromptAttachment[], capabilities: Pick<PromptCapabilities, "image">): ContentBlock[] {
  const prompt: ContentBlock[] = [{ type: "text", text }]
  for (const attachment of attachments) {
    if (attachment.data && attachment.mimeType.startsWith("image/") && capabilities.image) {
      prompt.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType })
    } else if (attachment.path) {
      prompt.push({
        type: "resource_link", name: attachment.name, uri: pathToFileURL(attachment.path).href,
        mimeType: attachment.mimeType, size: attachment.size,
      })
    }
  }
  return prompt
}

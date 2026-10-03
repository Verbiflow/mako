import { appendPromptAttachments } from "@mako/sessions/prompt-attachments"
import { open } from "node:fs/promises"
import { z } from "zod"
import type { PromptAttachment } from "../../shared.js"
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

/** One consumer, bounded by the host's one active turn and explicit steering calls. */
export class ClaudeInput implements AsyncIterable<SDKUserMessage> {
  private readonly messages: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  private closed = false

  send(message: SDKUserMessage): void {
    if (this.closed) throw new Error("The Claude input stream is closed")
    if (this.messages.length >= 32)
      throw new Error("Claude has too many pending inputs")
    this.messages.push(message)
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.messages.length = 0
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const message = this.messages.shift()
      if (message) yield message
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
  }
}

export const ClaudeModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "auto",
  "bypassPermissions",
])
export const ClaudeTuningSchema = z.object({
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  fast: z.boolean().optional(),
  agentTeams: z.boolean().optional(),
})

const ImageMimeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])
export async function claudeInputContent(
  text: string,
  attachments: PromptAttachment[]
): Promise<SDKUserMessage["message"]["content"]> {
  const blocks: Exclude<SDKUserMessage["message"]["content"], string> = [
    { type: "text", text: appendPromptAttachments(text, attachments.filter((attachment) => !attachment.mimeType.startsWith("image/")).map(({ name, mimeType, path }) => {
      if (!path) throw new Error(`Attachment ${name} was not staged`)
      return { name, mimeType, path }
    })) },
  ]
  for (const attachment of attachments) {
    if (!attachment.path)
      throw new Error(`Attachment ${attachment.name} was not staged`)
    if (attachment.mimeType.startsWith("image/")) {
      if (attachment.size !== undefined && attachment.size > 20 * 1024 * 1024)
        throw new Error("Claude image attachments must be under 20 MB")
      const mediaType = ImageMimeSchema.parse(attachment.mimeType)
      const file = await open(attachment.path, "r")
      let data: Buffer
      try {
        const limit = 20 * 1024 * 1024
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > limit)
          throw new Error("Claude image attachments must be files under 20 MB")
        const buffer = Buffer.alloc(limit + 1)
        let size = 0
        while (size < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            size,
            buffer.length - size,
            null
          )
          if (!bytesRead) break
          size += bytesRead
        }
        if (size > limit)
          throw new Error("Claude image attachments must be under 20 MB")
        data = buffer.subarray(0, size)
      } finally {
        await file.close()
      }
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: data.toString("base64"),
        },
      })
    }
  }
  return blocks
}

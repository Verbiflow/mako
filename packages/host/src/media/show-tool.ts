import { isAbsolute, resolve } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { MEDIA_META, type MediaReport } from "@mako/sessions/turn-media"
import type { TurnMedia } from "./turn-media.js"

/** The most files one `show` puts in front of the person. */
const MAX_SHOWN = 12

const DESCRIPTION = [
  "Put images, videos, audio, HTML pages or PDFs you made in front of the person, in your reply where you call it, each with a caption. Use it for screenshots, recordings and pages they asked for, or ones that show your work.",
  "Paths are absolute, or relative to your working folder. Mako keeps a copy of each, so the person still sees what you showed after the file changes. Other file types are refused.",
].join("\n")

const Input = z.object({
  files: z.array(z.object({
    path: z.string().trim().min(1).max(4_096).describe("The file, absolute or relative to your working folder."),
    caption: z.string().trim().min(1).max(500).optional().describe("What it shows, in a few words."),
  }).strict()).min(1).max(MAX_SHOWN),
  title: z.string().trim().min(1).max(200).optional().describe("A heading over them, when they belong together."),
}).strict()

export interface ShowToolDeps {
  media: TurnMedia
  /** The folder the calling conversation works in, for relative paths. */
  cwd(conversationId: string): string | undefined
}

/**
 * `show` on a conversation's `mako` server. Its result states what it
 * showed under `_meta[MEDIA_META]`, which the transcript draws where the
 * call stands whatever the call is named or wrapped in; its text says the
 * same to the agent.
 */
export function registerShowTool(server: McpServer, deps: ShowToolDeps, conversationId: () => string): void {
  server.registerTool(
    "show",
    {
      description: DESCRIPTION,
      inputSchema: Input,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const id = conversationId()
        const folder = deps.cwd(id)
        const shown: MediaReport["files"] = []
        for (const file of input.files) {
          if (!isAbsolute(file.path) && !folder) throw new Error(`${file.path} is relative and Mako doesn't know this session's folder. Pass an absolute path.`)
          const path = isAbsolute(file.path) ? resolve(file.path) : resolve(folder!, file.path)
          const kept = await deps.media.show(path)
          shown.push({ path, ...file.caption && { caption: file.caption }, ...kept.digest && { digest: kept.digest } })
        }
        const report: MediaReport = { via: "show", files: shown, ...input.title && { title: input.title } }
        const names = shown.map((file) => file.path.split("/").at(-1)).join(", ")
        return {
          content: [{ type: "text" as const, text: `Shown to the person in your reply: ${names}. Don't embed these again.` }],
          _meta: { [MEDIA_META]: report },
        }
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }
      }
    }
  )
}

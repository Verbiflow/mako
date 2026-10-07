import { basename, isAbsolute, join } from "node:path"
import { z } from "zod"
import type { ToolDetail } from "../content.js"

/** The fields of an OpenCode tool's input that name a file and a change to it. */
export const OpenCodeEditInput = z.object({ path: z.string().optional(), filePath: z.string().optional(), oldString: z.string().optional(), newString: z.string().optional(), content: z.string().optional() })

/** The file an OpenCode tool touched, and for an edit or a write the change it made. */
export function openCodeToolDetails(name: string, edit: z.infer<typeof OpenCodeEditInput> | undefined, cwd: string): ToolDetail[] | undefined {
  const relative = edit?.path ?? edit?.filePath
  if (!edit || !relative) return undefined
  const path = isAbsolute(relative) ? relative : join(cwd, relative)
  const details: ToolDetail[] = [{ type: "location", path }]
  if (name === "write" && edit.content !== undefined)
    details.push({ type: "diff", path, oldText: null, newText: edit.content })
  else if (edit.oldString !== undefined && edit.newString !== undefined)
    details.push({ type: "diff", path, oldText: edit.oldString, newText: edit.newString })
  return details
}

/** A file part's name as the window shows it: the file's own, though OpenCode's `read` names the part by its whole path. */
export function openCodeFileName(name: string | undefined): string {
  return name ? basename(name) : "Attachment"
}

/**
 * A tool result's metadata when its shell exited non-zero. OpenCode 2.0.1
 * keeps such a command `completed`, `exit: 1`, its output ending "Command
 * exited with code 1."; the window shows it failed, as every harness's.
 */
export const OpenCodeFailedExit = z.object({ exit: z.number().refine((code) => code !== 0) })

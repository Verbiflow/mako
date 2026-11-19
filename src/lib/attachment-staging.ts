import { STAGED_PART_BYTES, type StagedFile } from "@mako/host/contracts/git-workspace-search"
import type { PromptAttachment } from "@mako/host/contracts/providers-acp"
import type { Attachment } from "./attachments"

/** What staging needs of the bridge; a test passes one that counts what crosses it. */
export interface StagingBridge {
  pathForFile?(file: File): string | null
  stageFilePath(sourcePath: string): Promise<StagedFile>
  stageFile(name: string, base64: string): Promise<StagedFile>
  stageFilePart(name: string, base64: string, into?: { path: string; offset: number }): Promise<StagedFile>
}

/**
 * The browser's own encoder, off the main thread — not a fromCharCode loop
 * that freezes the composer for the length of a video.
 */
export function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.onload = () => {
      const result = reader.result
      const separator = result === null || result instanceof ArrayBuffer ? -1 : result.indexOf(",")
      if (result === null || result instanceof ArrayBuffer || separator === -1) reject(new Error("file reader returned no data URL"))
      else resolve(result.slice(separator + 1))
    }
    reader.readAsDataURL(blob)
  })
}

/**
 * Put a file where the agent can read it and answer the reference the draft keeps: its path, never its bytes.
 * A file with a path on this Mac is copied there by the host. One without (a paste, a capture) crosses the bridge
 * `STAGED_PART_BYTES` at a time, each piece encoded as it goes, so neither side ever holds the whole of it as one
 * string; what fits in one piece goes as the single call it always was.
 */
export async function stageAttachment(file: File, bridge: StagingBridge, encode: (blob: Blob) => Promise<string> = blobBase64): Promise<StagedFile> {
  const sourcePath = bridge.pathForFile?.(file) ?? null
  if (sourcePath) return bridge.stageFilePath(sourcePath)
  if (file.size <= STAGED_PART_BYTES) return bridge.stageFile(file.name, await encode(file))
  let staged: StagedFile | undefined
  for (let offset = 0; offset < file.size; offset += STAGED_PART_BYTES) {
    const piece = await encode(file.slice(offset, offset + STAGED_PART_BYTES))
    staged = await bridge.stageFilePart(file.name, piece, staged && { path: staged.path, offset })
  }
  if (!staged) throw new Error("The file is empty")
  return staged
}

/**
 * A draft's file as its message carries it: a reference, never its bytes. A staged file goes by its path alone;
 * bytes ride only with an image that has no path (one restored from a message another device sent).
 */
export function promptAttachment(item: Attachment): PromptAttachment {
  return {
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    data: item.kind === "image" && !item.stagedPath ? item.data : undefined,
    path: item.stagedPath,
  }
}

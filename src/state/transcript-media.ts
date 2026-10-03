import type { FileContents } from "@/lib/types"
import { getMako } from "@/lib/bridge"

/** Read through the owning conversation, without opening or changing a workbench tab. */
export async function readTranscriptFile({
  path,
  threadPath,
  liveId,
}: {
  path: string
  threadPath?: string
  liveId?: string
}): Promise<FileContents> {
  const bridge = getMako()
  const file = liveId
    ? await bridge.readLiveFile(liveId, path)
    : threadPath
      ? await bridge.readThreadFile(threadPath, path)
      : await bridge.readFile(path)
  return file.previewUrl ? { ...file, previewUrl: bridge.resolveFileUrl(file.previewUrl) } : file
}

export async function readTranscriptMedia(input: { path: string; threadPath?: string; liveId?: string }): Promise<{ url: string; mimeType: string }> {
  const file = await readTranscriptFile(input)
  if (!file.previewUrl || !file.mimeType) throw new Error("This file has no media preview")
  return { url: file.previewUrl, mimeType: file.mimeType }
}

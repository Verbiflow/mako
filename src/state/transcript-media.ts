import type { FileContents } from "@/lib/types"
import type { FileReadPurpose } from "@mako/host/contracts/git-workspace-search"
import { getMako } from "@/lib/bridge"

/**
 * Read through the owning conversation, without opening or changing a
 * workbench tab. Every URL the host signed comes back as this client
 * loads it.
 */
export async function readTranscriptFile({
  path,
  threadPath,
  liveId,
  purpose,
}: {
  path: string
  threadPath?: string
  liveId?: string
  purpose?: FileReadPurpose
}): Promise<FileContents> {
  const bridge = getMako()
  const file = liveId
    ? await bridge.readLiveFile(liveId, path, purpose)
    : threadPath
      ? await bridge.readThreadFile(threadPath, path, purpose)
      : await bridge.readFile(path)
  const resolve = (url: string | undefined) => (url ? bridge.resolveFileUrl(url) : undefined)
  return {
    ...file,
    ...(file.previewUrl && { previewUrl: resolve(file.previewUrl) }),
    ...(file.posterUrl && { posterUrl: resolve(file.posterUrl) }),
    ...(file.thumbnailUrl && { thumbnailUrl: resolve(file.thumbnailUrl) }),
  }
}

export async function readTranscriptMedia(input: { path: string; threadPath?: string; liveId?: string }): Promise<{ url: string; mimeType: string }> {
  const file = await readTranscriptFile({ ...input, purpose: "preview" })
  if (!file.previewUrl || !file.mimeType) throw new Error("This file has no media preview")
  return { url: file.previewUrl, mimeType: file.mimeType }
}

import type { AttachmentContent } from "@mako/sessions"
import type { MediaConfirmation } from "@mako/host/contracts/turn-media"
import { countedChanges, type RequestChanges } from "@mako/host/contracts/turn-changes"
import { mediaKind, mergeMedia, type MediaCandidate } from "@mako/sessions/turn-media"
import { exchangeMedia, type Exchange } from "@/lib/exchanges"
import { textOf } from "@/lib/format"
import { inlineFileTarget, markdownFileTarget } from "@/lib/file-citations"
import { filePreviewIdentity } from "@/lib/inline-file-links"

const LINKED = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const CODE = /`([^`\n]+)`/g

/**
 * The media files an answer's words already preview: images it embeds, and paths
 * it links or writes as code (`/tmp/shots/home.png`, `./out/flow.mp4`), as
 * the transcript previews them. A bare name (`home.png`) previews nothing,
 * so it isn't one.
 */
export function proseMediaSpellings(text: string): string[] {
  const spellings = new Set<string>()
  for (const [, href] of text.matchAll(LINKED)) {
    const target = markdownFileTarget(href)
    if (target && !target.line && mediaKind(target.path)) spellings.add(filePreviewIdentity(target.path))
  }
  for (const [, code] of text.matchAll(CODE)) {
    const target = inlineFileTarget(code!.trim())
    if (target && !target.line && mediaKind(target.path)) spellings.add(filePreviewIdentity(target.path))
  }
  return [...spellings]
}

/** Whether a spelling the prose previews means `path`: the same absolute path, or a relative one it ends with. */
function spelled(path: string, spellings: readonly string[]): boolean {
  const identity = filePreviewIdentity(path)
  return spellings.some((spelling) => spelling.startsWith("/") ? spelling === identity : identity.endsWith(`/${spelling.replace(/^~\//, "")}`))
}

const DIGEST = /^sha256:([a-f0-9]{64})$/

/**
 * The media files the turn's record of changes (`LiveRequest.changes`) says
 * it left: whatever wrote them, a script, a browser's screenshot or a
 * command line that names them only through `$PWD` included, which its
 * calls' records can't all say. Each carries the content the turn left, so
 * the host keeps those bytes and nothing the file held since.
 */
export function changedMedia(changes: RequestChanges | undefined, requestId: string): MediaCandidate[] {
  const counted = countedChanges(changes)
  if (!counted) return []
  return counted.files.flatMap((file): MediaCandidate[] => {
    const kind = mediaKind(file.path)
    const digest = file.after ? DIGEST.exec(file.after)?.[1] : undefined
    if (!kind || !digest || file.kind === "delete") return []
    return [{ key: file.path, kind, evidence: "wrote", callId: `turn:${requestId}`, path: file.path, digest, endedAt: counted.at }]
  })
}

/**
 * The exchange's media that belongs on its shelf: everything its calls
 * produced and its record of changes names, less what `show` already put
 * at its place and what the answer's words already preview.
 */
export function shelfMedia(exchange: Exchange, changes?: RequestChanges): MediaCandidate[] {
  const requestId = exchange.prompt?.requestId
  const changed = requestId ? changedMedia(changes, requestId) : []
  const called = exchangeMedia(exchange)
  // Where the record and a call say as much (both "it wrote this"), the record's names the bytes.
  const recorded = new Map(changed.map((candidate) => [candidate.key, candidate]))
  const media = changed.length
    ? mergeMedia([...called, ...changed]).map((candidate) => (candidate.evidence === "wrote" && recorded.get(candidate.key)) || candidate)
    : called
  if (!media.length) return media
  const spellings = exchange.response.flatMap((message) => (message.role === "assistant" ? proseMediaSpellings(textOf(message.blocks)) : []))
  return media.filter((candidate) => candidate.evidence !== "shown" && !(candidate.path && spelled(candidate.path, spellings)))
}

/**
 * A candidate as the attachment the transcript's media components draw:
 * the bytes a call returned, or the copy the host kept of the file. Nothing
 * until the host has kept it.
 */
export function mediaAttachment(candidate: MediaCandidate, answer: MediaConfirmation | undefined): AttachmentContent | undefined {
  const name = candidate.path?.split("/").at(-1)
  if (candidate.attachment) {
    const attachment = candidate.attachment
    return name && (attachment.name === "image" || attachment.name === "image_url") ? { ...attachment, name } : attachment
  }
  if (answer?.kind !== "kept" || !name) return undefined
  const { media } = answer
  return { type: "attachment", id: `${candidate.callId}:${candidate.key}`, name, mimeType: media.mimeType, source: { kind: "file", path: media.file, ...media.file !== media.path && { originalPath: media.path } } }
}

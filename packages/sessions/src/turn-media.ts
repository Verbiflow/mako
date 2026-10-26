import { z } from "zod"
import type { AttachmentContent, ToolDetail } from "./content.js"
import type { Entry, EntryOf } from "./entries.js"
import { identifyTool, type ToolIdentity } from "./tool-identity.js"

/**
 * What media a turn produced, from what its harness recorded: the calls'
 * results, attachments and effects, which are the same live and saved.
 *
 * The person asks for screenshots, a recording or a page and the agent
 * makes them, but says where in words the transcript doesn't link, or not
 * at all, or leaves them in a folded tool row. Asking the agent to embed
 * them is not enough on its own (another app's open issue is exactly the
 * agent not doing it), so this reads the facts instead, strongest first:
 *
 * 1. `shown`: the agent called `show` on Mako's server. Its result's
 *    `_meta[MEDIA_META]` names the files and their captions; where a harness
 *    drops `_meta`, the call's own arguments do.
 * 2. `attached`: an image block in a tool's result (a browser screenshot,
 *    `emitImage`), or a file the call viewed (Claude `Read`, Codex
 *    `view_image`) when another call of the turn made it.
 * 3. `produced`: a tool of Mako's own stated the files it made
 *    (`mako-computer` recordings, `artifacts.save()`, screenshot files,
 *    downloads), in the same `_meta` key.
 * 4. `wrote`: a create, write or modify effect on a media file.
 * 5. `named`: a command line named a media file. Only evidence: the host
 *    keeps it when the file changed while the command ran.
 *
 * Only media (images, video, audio, HTML and PDF), never text: a file the
 * transcript shows by itself must be one nobody reads as a secret.
 */

/**
 * How media reaches the person, in the words every agent is told: the
 * `mako` server's instructions and each harness's own (Claude's system
 * prompt, Codex's turn context, Mako's note before a prompt elsewhere).
 */
export const SHOW_MEDIA_LINE =
  "To show the person media you made (an image, video, audio file, HTML page or PDF), embed it as ![what it shows](/absolute/path) or call show on the mako server. Mako also shows media files your tools write, so say what each one shows."

/** The `_meta` key of a tool result that states the media it showed or produced; `ToolDetail` `media` is its decoding. */
export const MEDIA_META = "dev.mako/media"

export type MediaKind = "image" | "video" | "audio" | "html" | "pdf"

const EXTENSIONS: ReadonlyMap<string, MediaKind> = new Map([
  ...["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "heic", "tif", "tiff"].map((extension) => [extension, "image"] as const),
  ...["mp4", "mov", "m4v", "webm", "mkv"].map((extension) => [extension, "video"] as const),
  ...["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac", "opus"].map((extension) => [extension, "audio"] as const),
  ["html", "html"],
  ["htm", "html"],
  ["pdf", "pdf"],
])

/** The kind of media a path names by its extension, or undefined for anything else. */
export function mediaKind(path: string): MediaKind | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? EXTENSIONS.get(name.slice(dot + 1).toLowerCase()) : undefined
}

/** The kind of media a MIME type names. */
export function mediaKindOfType(mimeType: string): MediaKind | undefined {
  const type = mimeType.toLowerCase().split(";", 1)[0]!.trim()
  if (type.startsWith("image/")) return "image"
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  if (type === "text/html") return "html"
  if (type === "application/pdf") return "pdf"
  return undefined
}

const AbsolutePath = z.string().min(2).max(4_096).startsWith("/")
const MediaFile = z.object({
  path: AbsolutePath,
  caption: z.string().trim().min(1).max(500).optional().catch(undefined),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional().catch(undefined),
})
const MediaReportSchema = z.object({
  via: z.enum(["show", "produced"]),
  title: z.string().trim().min(1).max(200).optional().catch(undefined),
  files: z.array(MediaFile).min(1).max(64),
})
/** What a tool result states under `MEDIA_META`. */
export type MediaReport = z.infer<typeof MediaReportSchema>
/** A result's `_meta`, as far as this reads it. */
const MediaMetaSchema = z.object({ [MEDIA_META]: MediaReportSchema })
/** A result's `_meta` as its decoder kept it: any JSON. */
export type ResultMeta = z.infer<ReturnType<typeof z.json>> | undefined

/**
 * The media a tool result's `_meta` states, as the call's detail. Every
 * decoder that keeps a result's `_meta` reads it through this, so live and
 * saved say the same.
 */
export function mediaDetails(meta: ResultMeta): ToolDetail[] {
  const report = MediaMetaSchema.safeParse(meta).data?.[MEDIA_META]
  if (!report) return []
  const files = report.files.filter((file) => mediaKind(file.path))
  if (!files.length) return []
  const detail: Extract<ToolDetail, { type: "media" }> = { type: "media", via: report.via, files }
  if (report.title) detail.title = report.title
  return [detail]
}

/** How the turn's records say a file came about, strongest first. */
export type MediaEvidence = "shown" | "attached" | "produced" | "wrote" | "named"

const STRENGTH = { shown: 0, attached: 1, produced: 2, wrote: 3, named: 4 } satisfies Record<MediaEvidence, number>

/** One file or image a turn produced, as its records state it. */
export interface MediaCandidate {
  /** Unique in its turn: the path, or the call and the place of an attachment that has none. */
  key: string
  kind: MediaKind
  evidence: MediaEvidence
  /** The harness's id for the call that made or showed it, the same live and saved. */
  callId: string
  /** The file on disk, absolute. */
  path?: string
  /** The bytes the call returned, when it returned them. */
  attachment?: AttachmentContent
  /** The agent's words for it, from `show`. */
  caption?: string
  /** The heading of the `show` call that showed it. */
  title?: string
  /** The SHA-256 of the copy Mako kept when `show` showed it. */
  digest?: string
  /** An attachment of a file the call only looked at: kept only when another call of the turn made that file. */
  viewed?: true
  /** When the call ran, in epoch milliseconds: what a `named` file's change must fall within. */
  startedAt?: number
  endedAt?: number
}

/** The parts of a tool call this reads: a tool entry, or a transcript row drawn from one. */
export type MediaCall = Pick<EntryOf<"tool">, "id" | "status" | "input" | "details" | "attachments" | "effects" | "at" | "endedAt">

const ShowInput = z.object({
  files: z.array(z.object({ path: AbsolutePath, caption: z.string().trim().min(1).max(500).optional().catch(undefined) })).min(1).max(64),
  title: z.string().trim().min(1).max(200).optional().catch(undefined),
})

/** Whether `identity` is Mako's `show`, however the harness named or wrapped it. */
export function isShowCall(identity: ToolIdentity | undefined): boolean {
  return identity?.server === "mako" && identity.tool === "show"
}

/** `show`'s arguments in `text`, when it holds them as JSON. */
function showInput(text: string | undefined): z.infer<typeof ShowInput> | undefined {
  if (!text) return undefined
  try {
    return ShowInput.safeParse(JSON.parse(text)).data
  } catch {
    return undefined
  }
}

const QUOTED_PATH = /["'`](\/[^"'`\\\n]{1,4000}?)\\?["'`]/g

/** Absolute paths quoted in a script, which a call's input may hold escaped as JSON. */
function quotedPaths(text: string | undefined): string[] {
  if (!text) return []
  const found = new Set<string>()
  for (const [, path] of text.slice(0, 20_000).matchAll(QUOTED_PATH)) if (mediaKind(path!)) found.add(path!)
  return [...found]
}

/**
 * The media one call produced or showed. `identity` is what the call is
 * (`identifyTool`); it finds a `show` call whose harness kept no `_meta`,
 * wrapped or not.
 */
export function callMedia(call: MediaCall, identity?: ToolIdentity): MediaCandidate[] {
  if (call.status === "failed" || /refus|denied|reject/i.test(call.status ?? "")) return []
  const found: MediaCandidate[] = []
  const base = (evidence: MediaEvidence, kind: MediaKind, key: string): MediaCandidate => {
    const candidate: MediaCandidate = { key, kind, evidence, callId: call.id }
    if (call.at !== undefined) candidate.startedAt = call.at
    if (call.endedAt !== undefined) candidate.endedAt = call.endedAt
    return candidate
  }
  const atPath = (evidence: MediaEvidence, path: string) => {
    const kind = mediaKind(path)
    if (!kind) return undefined
    const candidate = base(evidence, kind, path)
    candidate.path = path
    found.push(candidate)
    return candidate
  }

  let shown = false
  for (const detail of call.details ?? []) {
    if (detail.type !== "media") continue
    shown ||= detail.via === "show"
    for (const file of detail.files) {
      const candidate = atPath(detail.via === "show" ? "shown" : "produced", file.path)
      if (!candidate) continue
      if (file.caption) candidate.caption = file.caption
      if (file.digest) candidate.digest = file.digest
      if (detail.title) candidate.title = detail.title
    }
  }
  if (!shown && isShowCall(identity)) {
    const own = showInput(identity?.input) ?? showInput(call.input)
    if (own)
      for (const file of own.files) {
        const candidate = atPath("shown", file.path)
        if (!candidate) continue
        if (file.caption) candidate.caption = file.caption
        if (own.title) candidate.title = own.title
      }
    // A script that called it (code mode) is read for the paths it passed, not its captions.
    else for (const path of quotedPaths(call.input)) atPath("shown", path)
  }

  // An image a call returned for the file it read is that file's bytes; a
  // call that only looks at images (Read, view_image) made none of them.
  const read = (call.effects ?? []).flatMap((effect) => (effect.kind === "read" && mediaKind(effect.path) ? [effect.path] : []))
  const looks = identity?.kind === "read"
  // What `show` returned is the files it showed.
  const attachments = shown || isShowCall(identity) ? [] : call.attachments ?? []
  for (const [index, attachment] of attachments.entries()) {
    const kind = mediaKindOfType(attachment.mimeType) ?? mediaKind(attachment.name)
    if (!kind || attachment.source.kind === "unavailable") continue
    const own = attachment.source.kind === "file" ? attachment.source.originalPath ?? attachment.source.path : undefined
    const viewed = read.length === 1 && attachments.length === 1 ? read[0] : own && (looks || read.includes(own)) ? own : undefined
    const path = viewed ?? own
    const candidate = base("attached", kind, path ?? `${call.id}#${index}`)
    if (path) candidate.path = path
    candidate.attachment = attachment
    if (viewed) candidate.viewed = true
    found.push(candidate)
  }

  for (const effect of call.effects ?? []) {
    if (effect.kind === "create" || effect.kind === "modify" || effect.kind === "write") atPath("wrote", effect.path)
    else if (effect.kind === "command") for (const path of effect.named ?? []) atPath("named", path)
  }
  return found
}

/**
 * One turn's media, in the order its calls made them: each file once, under
 * the strongest evidence any call gave, with the bytes a call returned and
 * the caption `show` gave it. A file a call only looked at stays out
 * unless another call of the turn made it.
 */
export function mergeMedia(candidates: Iterable<MediaCandidate>): MediaCandidate[] {
  const byKey = new Map<string, MediaCandidate[]>()
  for (const candidate of candidates) {
    const group = byKey.get(candidate.key)
    if (group) group.push(candidate)
    else byKey.set(candidate.key, [candidate])
  }
  const merged: MediaCandidate[] = []
  for (const group of byKey.values()) {
    if (group.every((candidate) => candidate.viewed)) continue
    const strongest = group.reduce((best, candidate) => (STRENGTH[candidate.evidence] < STRENGTH[best.evidence] ? candidate : best))
    const one: MediaCandidate = { ...strongest }
    delete one.viewed
    const attached = group.find((candidate) => candidate.attachment)?.attachment
    if (attached) one.attachment = attached
    const told = group.find((candidate) => candidate.caption)
    if (told?.caption && !one.caption) one.caption = told.caption
    if (told?.title && !one.title) one.title = told.title
    merged.push(one)
  }
  return merged
}

/**
 * The media of a turn's entries: what the transcript builds per call
 * (`callMedia`) and per exchange (`mergeMedia`), in one call, for checks that
 * hold live and saved history to the same answer.
 */
export function turnMedia(entries: readonly Entry[], harness?: string): MediaCandidate[] {
  return mergeMedia(entries.flatMap((entry) =>
    entry.type === "tool" ? callMedia(entry, identifyTool({ harness, name: entry.name, acpKind: entry.toolKind, title: entry.title, input: entry.input })) : []
  ))
}

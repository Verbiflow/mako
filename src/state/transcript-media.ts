import type { FileContents } from "@/lib/types"
import type { FileReadPurpose } from "@mako/host/contracts/git-workspace-search"
import { getMako } from "@/lib/bridge"
import { acpStore } from "@/state/acp-state"
import { hostConnectionStore } from "@/state/host-connection"

/** A file a transcript shows, as it's asked of the conversation that owns it. */
export interface TranscriptFileRead {
  path: string
  threadPath?: string
  liveId?: string
  purpose?: FileReadPurpose
  /**
   * The file is Mako's own copy of an attachment (a staged file, a kept one), which nothing rewrites: its read is
   * kept whatever the conversation has done since.
   */
  settled?: boolean
}

/** A read with something to draw by URL: a picture, a video, a PDF. */
export type TranscriptMedia = FileContents & { previewUrl: string; mimeType: string }

/** What a read is kept by: where its live conversation's record stood (the host's count of its changes), and whether it's at work. */
interface Revision {
  at: string
  running: boolean
}

interface Kept {
  file: FileContents
  at: number
  revision?: Revision
}

/**
 * How long a read is drawn from again without asking the host. A signed URL lasts an hour (`FILE_PREVIEW_TTL_MS`),
 * so one kept half that still has half its time when it's drawn; text has no URL to fail and says nothing when
 * its file changes outside the conversation, so it's kept a shorter while.
 */
const URL_KEPT_MS = 30 * 60_000
const TEXT_KEPT_MS = 5 * 60_000
/** While its conversation is at work a file may be written with no call saying so yet, so a read is kept only this long. */
const RUNNING_KEPT_MS = 5_000
const READS_KEPT = 400
/** Text longer than this is read again rather than held: a few previews of 2 MB files would hold the window's memory. */
const TEXT_KEPT_CHARS = 256_000

const kept = new Map<string, Kept>()
const reading = new Map<string, Promise<FileContents>>()

// Each URL is signed by the host process that read it, so none outlives the link to that host.
hostConnectionStore.subscribe(() => {
  if (hostConnectionStore.get().kind === "disconnected") forgetTranscriptFiles()
})

const keyOf = (read: TranscriptFileRead) => JSON.stringify([read.liveId ?? null, read.liveId ? null : read.threadPath ?? null, read.path, read.purpose ?? null])

function revisionOf(read: TranscriptFileRead): Revision | undefined {
  if (read.settled || !read.liveId) return undefined
  const conversation = acpStore.get().conversations[read.liveId]
  return conversation?.kind === "live"
    ? { at: `${conversation.epoch ?? ""}:${conversation.revision ?? 0}`, running: conversation.session.status === "running" }
    : undefined
}

function current(read: TranscriptFileRead, entry: Kept, now: number): boolean {
  const age = now - entry.at
  if (age > (entry.file.previewUrl ? URL_KEPT_MS : TEXT_KEPT_MS)) return false
  const revision = revisionOf(read)
  if (!revision) return true
  // Kept from before the conversation last moved (a call, a turn), or while the agent works: what's on disk may have moved.
  if (entry.revision?.at !== revision.at) return false
  return !revision.running || age <= RUNNING_KEPT_MS
}

/**
 * A read this window already holds, for a preview to draw at once as it mounts: a row scrolled back into view, a
 * Thread opened again. Undefined when nothing is held, or what's held may be stale.
 */
export function heldTranscriptFile(read: TranscriptFileRead, now = Date.now()): FileContents | undefined {
  const key = keyOf(read)
  const entry = kept.get(key)
  if (!entry) return undefined
  if (current(read, entry, now)) return entry.file
  kept.delete(key)
  return undefined
}

/** Forget every kept read: the host that signed their URLs went away, or a test starts over. */
export function forgetTranscriptFiles(): void {
  kept.clear()
  reading.clear()
}

/**
 * Read through the owning conversation, without opening or changing a
 * workbench tab. Every URL the host signed comes back as this client
 * loads it. A read is kept by its conversation, path and purpose
 * (`heldTranscriptFile`), and two previews asking at once share one call;
 * `fresh` asks the host whatever is held: a Retry, a Refresh, a URL that
 * failed to load.
 */
export function readTranscriptFile(read: TranscriptFileRead, options: { fresh?: boolean } = {}): Promise<FileContents> {
  const key = keyOf(read)
  if (!options.fresh) {
    const held = heldTranscriptFile(read)
    if (held) return Promise.resolve(held)
    const pending = reading.get(key)
    if (pending) return pending
  }
  const revision = revisionOf(read)
  const asked = ask(read).then((file) => {
    // A read answered without its text (a fixture's picture) holds none.
    const text = (Object.hasOwn(file, "contents") ? file.contents.length : 0) + (file.artifactPreview?.kind === "html" ? file.artifactPreview.html.length : 0)
    if (text <= TEXT_KEPT_CHARS) {
      kept.delete(key)
      kept.set(key, { file, at: Date.now(), revision })
      if (kept.size > READS_KEPT) {
        const oldest = kept.keys().next().value
        if (oldest !== undefined) kept.delete(oldest)
      }
    }
    return file
  })
  reading.set(key, asked)
  const done = () => {
    if (reading.get(key) === asked) reading.delete(key)
  }
  asked.then(done, done)
  return asked
}

async function ask({ path, threadPath, liveId, purpose }: TranscriptFileRead): Promise<FileContents> {
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

const isMedia = (file: FileContents): file is TranscriptMedia => Boolean(file.previewUrl && file.mimeType)

/** A media attachment's file as its preview draws it; throws for a file with nothing to draw. */
export async function readTranscriptMedia(read: TranscriptFileRead, options: { fresh?: boolean } = {}): Promise<TranscriptMedia> {
  const file = await readTranscriptFile({ ...read, purpose: "preview" }, options)
  if (!isMedia(file)) throw new Error("This file has no media preview")
  return file
}

/** `heldTranscriptFile` for a media attachment: what `readTranscriptMedia` would answer, when it's held. */
export function heldTranscriptMedia(read: TranscriptFileRead): TranscriptMedia | undefined {
  const file = heldTranscriptFile({ ...read, purpose: "preview" })
  return file && isMedia(file) ? file : undefined
}

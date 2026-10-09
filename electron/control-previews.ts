import { randomUUID } from "node:crypto"
import { imageSize } from "image-size"
import {
  type BrowserService,
  type BrowserFrame,
} from "@mako/control-runtime/browser"
import {
  type AppshotTarget,
  type BrowserTarget,
  type ControlActivity,
  type ControlImage,
  type ControlPreview,
} from "@mako/control-runtime/contracts"
import { heavy } from "./heavy-packages.js"

interface PreviewEntry {
  preview: ControlPreview
  generation: number
  watchers: Map<string, number>
  /** The host client each watcher reads through. */
  clients: Map<string, string>
  target?: BrowserTarget
  owner?: string
  starting?: Promise<void>
  stopStream?: () => Promise<void>
  expiry?: NodeJS.Timeout
  nextFrameAt?: number
  frameTimer?: NodeJS.Timeout
  latest?: BrowserFrame
  sourceFrames: number
  sourceSlot?: number
  authorize?: () => void
  publish?: NodeJS.Timeout
  oversized?: boolean
  /** Counts native snapshots, so a thumbnail finishing after a newer snapshot or another target is dropped. */
  snapshots: number
}
type PreviewFrame = NonNullable<ControlPreview["frame"]>
export interface PreviewBox {
  width: number
  height: number
}

type Thumbnail = (image: ControlImage) => Promise<ControlImage | null>

/** A native snapshot as the viewer shows it: JPEG, at most 1440 pixels wide; none for an image too large to decode. */
export async function previewThumbnail(image: ControlImage): Promise<ControlImage | null> {
  const bytes = Buffer.from(image.data, "base64")
  const { width, height } = imageSize(bytes)
  if (!width || !height || width * height > 32_000_000) return null
  const sharp = await heavy.sharp.load("control preview")
  const jpeg = await sharp(bytes).resize({ width: Math.min(1440, width) }).jpeg({ quality: 85 }).toBuffer()
  return { data: jpeg.toString("base64"), mimeType: "image/jpeg" }
}

/** One bounded image per task. Image bytes only cross IPC when its visible preview requests them. */
export class ControlPreviews {
  private readonly entries = new Map<string, PreviewEntry>()
  private readonly browser: BrowserService
  private readonly thumbnail: Thumbnail
  private readonly changed: (activity: ControlActivity) => void
  private readonly scaled = new WeakMap<PreviewFrame, Map<string, Promise<PreviewFrame>>>()
  constructor(
    browser: BrowserService,
    thumbnail: Thumbnail,
    changed: (activity: ControlActivity) => void
  ) {
    this.browser = browser
    this.thumbnail = thumbnail
    this.changed = changed
  }

  observe(activity: Omit<ControlActivity, "updatedAt">, image?: ControlImage) {
    let entry = this.entries.get(activity.conversationId)
    const next = { ...activity, updatedAt: Date.now() }
    if (!entry) {
      if (this.entries.size >= 64) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined) this.remove(oldest)
      }
      entry = {
        preview: { activity: next, frame: null },
        watchers: new Map(),
        clients: new Map(),
        generation: 0,
        sourceFrames: 0,
        snapshots: 0,
      }
      this.entries.set(activity.conversationId, entry)
    }
    if (
      entry.preview.activity.kind !== activity.kind ||
      entry.preview.activity.target !== activity.target
    ) {
      this.stop(entry)
      entry.target = undefined
      entry.authorize = undefined
      entry.preview.frame = null
      entry.preview.window = undefined
      entry.oversized = false
      entry.snapshots++
    }
    entry.preview.activity = next
    if (image) void this.snapshot(activity.conversationId, entry, image)
    this.publish(entry)
  }

  private publish(entry: PreviewEntry) {
    if (entry.publish) return
    entry.publish = setTimeout(() => {
      entry.publish = undefined
      this.changed(entry.preview.activity)
    }, 250)
    entry.publish.unref()
  }

  /** Native snapshots pass the thumbnail boundary before retention; the newest one for the current target wins. */
  private async snapshot(conversationId: string, entry: PreviewEntry, image: ControlImage) {
    const snapshot = ++entry.snapshots
    let thumbnail: ControlImage | null
    try { thumbnail = await this.thumbnail(image) } catch { return }
    if (snapshot !== entry.snapshots || this.entries.get(conversationId) !== entry) return
    if (!thumbnail || thumbnail.data.length > 2 * 1024 * 1024) return
    this.frame(entry, { mimeType: thumbnail.mimeType, bytes: Buffer.from(thumbnail.data, "base64") })
    this.publish(entry)
  }

  browserTarget(
    conversationId: string,
    target: BrowserTarget,
    authorize: () => void,
    owner = conversationId
  ) {
    const entry = this.entries.get(conversationId)
    if (!entry || entry.preview.activity.kind !== "browser") return
    if (
      entry.owner !== owner ||
      JSON.stringify(entry.target) !== JSON.stringify(target)
    ) {
      this.stop(entry)
      entry.target = target
      entry.oversized = false
    }
    entry.owner = owner
    entry.authorize = authorize
    this.capture(entry)
  }

  computerTarget(
    conversationId: string,
    target: AppshotTarget,
    authorize: () => void
  ) {
    const entry = this.entries.get(conversationId)
    if (!entry || entry.preview.activity.kind !== "computer") return
    entry.preview.window = target
    entry.authorize = authorize
  }

  nativeWindow(conversationId: string): AppshotTarget | null {
    const entry = this.entries.get(conversationId)
    if (!entry?.preview.window || !entry.authorize) return null
    entry.authorize()
    return entry.preview.window
  }

  read(
    conversationId: string,
    watching: boolean,
    watcher = "panel",
    client = "local"
  ): ControlPreview | null {
    const entry = this.entries.get(conversationId)
    if (!entry) return null
    try {
      entry.authorize?.()
    } catch {
      this.remove(conversationId)
      return null
    }
    for (const [id, until] of entry.watchers)
      if (until < Date.now()) entry.watchers.delete(id)
    if (watching) {
      if (entry.watchers.size < 16 || entry.watchers.has(watcher)) {
        entry.watchers.set(watcher, Date.now() + 3_000)
        for (const id of entry.clients.keys())
          if (!entry.watchers.has(id)) entry.clients.delete(id)
        entry.clients.set(watcher, client)
      }
      this.capture(entry)
    } else {
      entry.watchers.delete(watcher)
      if (entry.watchers.size === 0) this.stop(entry)
    }
    if (watching && entry.oversized)
      throw new Error("Preview paused because the captured frame exceeds its size limit")
    // Retain the last screenshot, but release live native capture after the action settles.
    return entry.preview.activity.status !== "running" &&
      Date.now() - entry.preview.activity.updatedAt >= 5_000
      ? { ...entry.preview, window: undefined }
      : entry.preview
  }

  /** Who keeps a task's live capture running: `client`'s own viewers, other
   * clients' viewers (another window showing the same task), and whether a
   * stream is running. A stream with no viewers is a leak. */
  viewers(conversationId: string, client: string) {
    const entry = this.entries.get(conversationId)
    let own = 0, others = 0
    for (const [id, until] of entry?.watchers ?? [])
      if (until >= Date.now()) {
        if (entry!.clients.get(id) === client) own++
        else others++
      }
    return { own, others, capturing: Boolean(entry?.stopStream || entry?.starting) }
  }

  /**
   * The preview with its frame scaled once, on the host, to the pixels the
   * viewers display (`box` covers them, in device pixels), so they draw it
   * 1:1. Replies cross the host socket in 8 KB chunks that each wait for the
   * reader to be scheduled, so under load a full 1080p frame takes seconds to
   * arrive while a viewer-sized one does not. Recordings and screenshots
   * never read through here.
   */
  async sized(preview: ControlPreview, box?: PreviewBox): Promise<ControlPreview> {
    const frame = preview.frame
    if (!box || !frame || frame.image.mimeType !== "image/jpeg") return preview
    let source: { width?: number; height?: number }
    try { source = imageSize(frame.image.bytes) } catch { return preview }
    const { width, height } = source
    if (!width || !height || !(box.width > 0) || !(box.height > 0)) return preview
    // The same fit the viewer computes, so its canvas is exactly this size.
    const fit = Math.min(box.width / width, box.height / height, 1)
    const size = { width: Math.max(1, Math.round(width * fit)), height: Math.max(1, Math.round(height * fit)) }
    if (size.width * 8 > width * 7) return preview
    const key = `${size.width}x${size.height}`
    let bySize = this.scaled.get(frame)
    if (!bySize) this.scaled.set(frame, (bySize = new Map()))
    let scaling = bySize.get(key)
    if (!scaling) {
      if (bySize.size >= 8) bySize.clear()
      // Full chroma: at thumbnail sizes 4:2:0 visibly softens coloured text.
      scaling = heavy.sharp.load("control preview")
        .then((sharp) => sharp(frame.image.bytes)
          .resize(size.width, size.height, { fit: "fill", kernel: "mks2021" })
          .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
          .toBuffer())
        .then((bytes) => {
          // SAFETY: sharp returns a Node Buffer, which is never backed by a SharedArrayBuffer.
          const buffer = bytes.buffer as ArrayBuffer
          return { ...frame, id: `${frame.id}:${key}`, image: { mimeType: "image/jpeg" as const, bytes: new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength) } }
        })
      bySize.set(key, scaling)
    }
    try {
      return { ...preview, frame: await scaling }
    } catch {
      return preview
    }
  }

  /** Browser frames arrive with validated dimensions; native snapshots arrive here as thumbnails. */
  private frame(entry: PreviewEntry, pixels: PreviewFrame["image"], capturedAt = Date.now(), sequence?: number) {
    // Bound actual bytes; base64 expansion no longer consumes the delivery budget.
    entry.oversized = pixels.bytes.byteLength > 2 * 1024 * 1024
    if (entry.oversized) return
    entry.preview.frame = { id: randomUUID(), image: pixels, capturedAt, publishedAt: Date.now(), sequence }
  }

  private stop(entry: PreviewEntry) {
    entry.generation++
    clearTimeout(entry.expiry)
    clearTimeout(entry.frameTimer)
    entry.frameTimer = undefined
    entry.latest = undefined
    const stop = entry.stopStream
    entry.stopStream = undefined
    void stop?.().catch(() => {})
  }
  private capture(entry: PreviewEntry) {
    clearTimeout(entry.expiry)
    entry.expiry = setTimeout(() => {
      for (const [id, until] of entry.watchers)
        if (until <= Date.now()) entry.watchers.delete(id)
      if (!entry.watchers.size) this.stop(entry)
    }, 3_050)
    entry.expiry.unref()
    const target = entry.target,
      authorize = entry.authorize
    if (
      !target ||
      !authorize ||
      entry.starting ||
      entry.stopStream ||
      !entry.watchers.size
    )
      return
    const generation = entry.generation
    entry.starting = this.browser
      .previewStream(
        entry.owner ?? entry.preview.activity.conversationId,
        target,
        () => {
          if (entry.generation !== generation) throw new Error("Preview target changed")
          entry.authorize?.()
        },
        (value) => {
          if (
            entry.generation !== generation ||
            ![...entry.watchers.values()].some((until) => until >= Date.now())
          )
            return
          // Latest-frame delivery: no queue of old images when UI/transport is busy.
          entry.latest = value
          // Source-clock 60 fps slots, the most the host publishes; a faster
          // source or late delivery cannot read as a viewer shortfall.
          const slot = Math.floor(value.capturedAt / (1000 / 60))
          if (slot !== entry.sourceSlot) {
            entry.sourceSlot = slot
            entry.sourceFrames++
          }
          if (entry.frameTimer) return
          const flush = () => {
            entry.frameTimer = undefined
            const latest = entry.latest
            entry.latest = undefined
            if (!latest) return
            const now = performance.now()
            entry.nextFrameAt = Math.max((entry.nextFrameAt ?? now) + 1000 / 60, now)
            this.frame(entry, { bytes: latest.bytes, mimeType: "image/jpeg" }, latest.capturedAt, entry.sourceFrames)
            this.changed(entry.preview.activity)
          }
          const remaining =
            (entry.nextFrameAt ?? -Infinity) - performance.now()
          if (remaining <= 0) flush()
          else {
            entry.frameTimer = setTimeout(flush, Math.ceil(remaining))
            entry.frameTimer.unref()
          }
        },
        () => {
          if (entry.generation === generation) this.stop(entry)
        }
      )
      .then(async (stop) => {
        if (entry.generation !== generation || !entry.watchers.size)
          await stop()
        else entry.stopStream = stop
      })
      .catch(() => {
        // Preview cannot fail, replay or retarget agent input.
      })
      .finally(() => {
        entry.starting = undefined
        if (entry.generation !== generation && entry.watchers.size)
          this.capture(entry)
      })
  }

  remove(conversationId: string) {
    const entry = this.entries.get(conversationId)
    if (entry) {
      entry.target = undefined
      entry.watchers.clear()
      entry.clients.clear()
      this.stop(entry)
    }
    if (entry?.publish) clearTimeout(entry.publish)
    this.entries.delete(conversationId)
  }

  close() {
    for (const id of this.entries.keys()) this.remove(id)
  }
}

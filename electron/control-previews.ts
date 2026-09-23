import { randomUUID } from "node:crypto"
import type { BrowserService } from "./browser-service.js"
import type { BrowserFrame } from "./browser-capture.js"
import type { AppshotTarget } from "./contracts/appshots.js"
import type { BrowserTarget } from "./contracts/browser-control.js"
import {
  type ControlActivity,
  type ControlImage,
  type ControlPreview,
} from "./contracts/control-preview.js"

interface PreviewEntry {
  preview: ControlPreview
  generation: number
  watchers: Map<string, number>
  target?: BrowserTarget
  owner?: string
  starting?: Promise<void>
  stopStream?: () => Promise<void>
  expiry?: NodeJS.Timeout
  nextFrameAt?: number
  frameTimer?: NodeJS.Timeout
  latest?: BrowserFrame
  authorize?: () => void
  publish?: NodeJS.Timeout
}

/** One bounded image per task. Image bytes only cross IPC when its visible preview requests them. */
export class ControlPreviews {
  private readonly entries = new Map<string, PreviewEntry>()
  private readonly browser: BrowserService
  private readonly thumbnail: (image: ControlImage) => ControlImage | null
  private readonly changed: (activity: ControlActivity) => void
  constructor(
    browser: BrowserService,
    thumbnail: (image: ControlImage) => ControlImage | null,
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
        generation: 0,
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
    }
    entry.preview.activity = next
    if (image) this.frame(entry, image)
    if (!entry.publish) {
      entry.publish = setTimeout(() => {
        entry.publish = undefined
        this.changed(entry.preview.activity)
      }, 250)
      entry.publish.unref()
    }
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
    watcher = "panel"
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
      if (entry.watchers.size < 16 || entry.watchers.has(watcher))
        entry.watchers.set(watcher, Date.now() + 3_000)
      this.capture(entry)
    } else {
      entry.watchers.delete(watcher)
      if (entry.watchers.size === 0) this.stop(entry)
    }
    // Retain the last screenshot, but release live native capture after the action settles.
    return entry.preview.activity.status !== "running" &&
      Date.now() - entry.preview.activity.updatedAt >= 5_000
      ? { ...entry.preview, window: undefined }
      : entry.preview
  }

  private frame(entry: PreviewEntry, image: ControlImage, stream = false) {
    // The native thumbnail boundary decodes and bounds pixels before retention.
    let thumbnail: ControlImage | null
    try {
      // BrowserCapture already checked the encoded dimensions and byte budget.
      // Keep its JPEG rather than decoding/resizing/re-encoding every live frame.
      thumbnail = stream && image.data.length <= 2 * 1024 * 1024 ? image : this.thumbnail(image)
    } catch {
      return
    }
    if (!thumbnail || thumbnail.data.length > 2 * 1024 * 1024) return
    entry.preview.frame = {
      id: randomUUID(),
      image: thumbnail,
      capturedAt: Date.now(),
    }
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
          if (entry.frameTimer) return
          const flush = () => {
            entry.frameTimer = undefined
            const latest = entry.latest
            entry.latest = undefined
            if (!latest) return
            const now = performance.now()
            entry.nextFrameAt = Math.max((entry.nextFrameAt ?? now) + 1000 / 60, now)
            this.frame(entry, { data: latest.data, mimeType: "image/jpeg" }, true)
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
      this.stop(entry)
    }
    if (entry?.publish) clearTimeout(entry.publish)
    this.entries.delete(conversationId)
  }

  close() {
    for (const id of this.entries.keys()) this.remove(id)
  }
}

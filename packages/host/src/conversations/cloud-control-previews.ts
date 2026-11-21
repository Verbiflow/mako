import { randomBytes } from "node:crypto"
import { Payload, type ClientSession, type MediaWatch, type Problem } from "@mako/protocol"
import { decodeControlVideo, encodeControlVideoBatch, type ControlActivity, type ControlPreview, type ControlVideoBatch } from "@mako/control-runtime/contracts"
import { controlVideoEnding, type ControlVideoEnding, type ControlVideoWatch } from "../contracts/control-video.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { MethodTable } from "../base/methods.js"

/** A viewer that hasn't read for this long has gone: its window closed or hid the preview. */
const VIEWER_MS = 3_000
/** At most this many viewers, across this Mac's windows, watch one conversation's preview. */
const VIEWERS = 8
/** A viewer's unread packets past this many bytes are dropped, and it starts again from a fresh picture. */
const QUEUE_BYTES = 4 * 1024 * 1024
/** A read waits at most this long for a packet. */
const READ_MS = 1_000
/** What arrived is acked this soon, or at once past this many bytes, so the machine paces itself to what arrives. */
const ACK_MS = 50
const ACK_BYTES = 128 * 1024
/** A fresh picture or another size is asked of the machine at most this often. */
const ASK_MS = 250
/** A watch the link ended is opened again after this, doubling, this many times before it waits for the agent. */
const RETRY_MS = 500
const RETRIES = 4

type Box = { width: number; height: number }

interface Viewer {
  box?: Box
  readAt: number
  queue: Uint8Array[]
  bytes: number
  /** It has a key frame, so deltas decode; until then only a poster or a key frame is worth sending it. */
  keyed: boolean
  painted: boolean
  /** Resolves a read waiting for packets. */
  waiting?: () => void
}

interface Watch {
  media: MediaWatch
  /** The request last sent, as JSON, so an unchanged one isn't sent again. */
  asked: string
  askedAt: number
  asking?: NodeJS.Timeout
  received: number
  acked: number
  acking?: NodeJS.Timeout
}

interface Preview {
  conversationId: string
  threadId: string
  activity?: ControlActivity
  /** Why the machine stopped sending, until the agent acts again. */
  ended?: ControlVideoEnding
  viewers: Map<string, Viewer>
  watch?: Watch
  opening?: Promise<void>
  retries: number
  retry?: NodeJS.Timeout
  sweep?: NodeJS.Timeout
}

export interface CloudControlPreviewsOptions {
  /** The session to the cloud as this Mac's device. */
  session(): Promise<ClientSession>
}

/**
 * The previews of this Mac's cloud conversations. The picture is the machine's tab as live video, which comes through
 * the conversation's Thread, never its stream: one watch per conversation however many windows show it, opened while
 * one does and closed once none has read for a few seconds. Each window's viewer reads its own queue; one that falls
 * behind drops what it hasn't read and starts again from a fresh picture without slowing the others. What arrives is
 * acked as it arrives, so the machine sends only as fast as the network carries.
 */
export class CloudControlPreviews {
  readonly #options: CloudControlPreviewsOptions
  readonly #previews = new Map<string, Preview>()
  #closed = false

  constructor(options: CloudControlPreviewsOptions) {
    this.#options = options
  }

  /** The agent acted on its machine: a preview that ended streams again when next watched. */
  activity(threadId: string, activity: ControlActivity): void {
    const preview = this.#preview(activity.conversationId, threadId)
    preview.activity = activity
    if (preview.ended) hostLog("cloud-control-previews", "the agent acted; the preview's video can stream again", { conversationId: preview.conversationId, after: preview.ended })
    preview.ended = undefined
    preview.retries = 0
    this.#open(preview)
  }

  /**
   * The preview a window shows; none until the agent has shown something. Its picture is read as video (`read`), whose
   * readers alone keep the watch open: a window polling this for the activity isn't one.
   */
  preview(conversationId: string): ControlPreview | null {
    const preview = this.#previews.get(conversationId)
    if (!preview?.activity || preview.ended === "gone") return null
    const shown: ControlPreview = { activity: preview.activity, frame: null, video: true }
    if (preview.ended) shown.paused = true
    return shown
  }

  /** What `viewer` was sent since it last read, waiting a moment for a packet when there's none yet. */
  async read(conversationId: string, viewer: string, box?: Box): Promise<ControlVideoBatch> {
    const preview = this.#previews.get(conversationId)
    if (!preview?.activity || preview.ended) return { live: false, packets: [] }
    const watching = this.#viewer(preview, viewer, box)
    if (!watching) return { live: false, packets: [] }
    if (!watching.queue.length) {
      watching.waiting?.()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, READ_MS)
        function done() {
          clearTimeout(timer)
          if (watching?.waiting === done) watching.waiting = undefined
          resolve()
        }
        watching.waiting = done
      })
    }
    const packets = watching.queue
    watching.queue = []
    watching.bytes = 0
    return { live: !preview.ended && this.#previews.get(conversationId) === preview, packets }
  }

  /** The conversation is no longer this Mac's to show. */
  forget(conversationId: string): void {
    const preview = this.#previews.get(conversationId)
    if (!preview) return
    this.#previews.delete(conversationId)
    this.#stop(preview)
    for (const viewer of preview.viewers.values()) viewer.waiting?.()
  }

  close(): void {
    this.#closed = true
    for (const id of this.#previews.keys()) this.forget(id)
  }

  #preview(conversationId: string, threadId: string): Preview {
    let preview = this.#previews.get(conversationId)
    if (preview && preview.threadId !== threadId) {
      this.forget(conversationId)
      preview = undefined
    }
    if (!preview) {
      preview = { conversationId, threadId, viewers: new Map(), retries: 0 }
      this.#previews.set(conversationId, preview)
    }
    return preview
  }

  #viewer(preview: Preview, id: string, asked?: Box): Viewer | undefined {
    let viewer = preview.viewers.get(id)
    if (!viewer) {
      if (preview.viewers.size >= VIEWERS) return undefined
      viewer = { readAt: Date.now(), queue: [], bytes: 0, keyed: false, painted: false }
      preview.viewers.set(id, viewer)
      this.#sweep(preview)
      // The watch already open is past its poster and key frame: the machine sends both again.
      this.#ask(preview, true)
    }
    viewer.readAt = Date.now()
    const box = asked && asked.width >= 16 && asked.height >= 16
      ? { width: Math.min(8192, Math.round(asked.width)), height: Math.min(8192, Math.round(asked.height)) }
      : undefined
    if (box?.width !== viewer.box?.width || box?.height !== viewer.box?.height) {
      viewer.box = box
      this.#ask(preview, false)
    }
    this.#open(preview)
    return viewer
  }

  #leave(preview: Preview, id: string): void {
    const viewer = preview.viewers.get(id)
    if (!viewer) return
    preview.viewers.delete(id)
    viewer.waiting?.()
    if (!preview.viewers.size) this.#stop(preview)
    else this.#ask(preview, false)
  }

  /** Viewers that stopped reading leave; with none left, the watch closes. */
  #sweep(preview: Preview): void {
    if (preview.sweep) return
    preview.sweep = setInterval(() => {
      for (const [id, viewer] of preview.viewers)
        if (Date.now() - viewer.readAt > VIEWER_MS) this.#leave(preview, id)
      if (!preview.viewers.size) {
        clearInterval(preview.sweep)
        preview.sweep = undefined
      }
    }, 1_000)
    preview.sweep.unref()
  }

  #request(preview: Preview): ControlVideoWatch {
    let width = 0, height = 0
    for (const viewer of preview.viewers.values()) {
      if (!viewer.box) return { kind: "control-video", conversationId: preview.conversationId }
      width = Math.max(width, viewer.box.width)
      height = Math.max(height, viewer.box.height)
    }
    return width && height
      ? { kind: "control-video", conversationId: preview.conversationId, box: { width, height } }
      : { kind: "control-video", conversationId: preview.conversationId }
  }

  /** The machine hears the viewers' combined size when it changed, or is asked for a fresh picture; at most every `ASK_MS`. */
  #ask(preview: Preview, fresh: boolean): void {
    const watch = preview.watch
    if (!watch) return
    const request = this.#request(preview)
    const asked = JSON.stringify(request)
    if (!fresh && asked === watch.asked && !watch.asking) return
    if (watch.asking) return
    const wait = watch.askedAt + ASK_MS - Date.now()
    const send = () => {
      watch.asking = undefined
      if (preview.watch !== watch) return
      watch.askedAt = Date.now()
      const latest = this.#request(preview)
      watch.asked = JSON.stringify(latest)
      watch.media.update(Payload.of(latest))
    }
    if (wait <= 0) return send()
    watch.asking = setTimeout(send, wait)
    watch.asking.unref()
  }

  #open(preview: Preview): void {
    if (this.#closed || preview.watch || preview.opening || preview.retry || preview.ended || !preview.viewers.size || !preview.activity) return
    if (this.#previews.get(preview.conversationId) !== preview) return
    preview.opening = this.#options.session().then(
      (session) => {
        if (this.#previews.get(preview.conversationId) !== preview || !preview.viewers.size || preview.ended) return
        const stream = `cv${randomBytes(12).toString("base64url")}`
        const request = this.#request(preview)
        const watch: Watch = {
          media: session.watch({ threadId: preview.threadId, stream, request: Payload.of(request) }),
          asked: JSON.stringify(request),
          askedAt: Date.now(),
          received: 0,
          acked: 0,
        }
        preview.watch = watch
        for (const viewer of preview.viewers.values()) {
          viewer.keyed = false
          viewer.painted = false
        }
        void this.#pump(preview, watch)
      },
      (error: Error) => this.#lost(preview, error.message)
    ).finally(() => {
      preview.opening = undefined
    })
  }

  async #pump(preview: Preview, watch: Watch): Promise<void> {
    try {
      for (;;) {
        const delivery = await watch.media.next()
        if (preview.watch !== watch) return
        if (delivery.kind === "ended") return this.#ended(preview, watch, delivery.problem)
        watch.received += delivery.data.byteLength
        this.#deliver(preview, delivery.data)
        this.#ack(watch)
      }
    } catch (error) {
      if (preview.watch === watch) this.#ended(preview, watch, undefined, error instanceof Error ? error.message : String(error))
    }
  }

  #deliver(preview: Preview, data: Uint8Array): void {
    let kind: "key" | "delta" | "poster"
    try {
      kind = decodeControlVideo(data).kind
    } catch {
      return hostWarn("cloud-control-previews", "dropped a video packet it couldn't read", { conversationId: preview.conversationId, bytes: data.byteLength })
    }
    let behind = false
    for (const viewer of preview.viewers.values()) {
      if (kind === "delta" ? !viewer.keyed : kind === "poster" && viewer.painted) continue
      if (viewer.bytes + data.byteLength > QUEUE_BYTES) {
        viewer.queue = []
        viewer.bytes = 0
        viewer.keyed = viewer.painted = false
        behind = true
        continue
      }
      viewer.queue.push(data)
      viewer.bytes += data.byteLength
      viewer.painted = true
      if (kind === "key") viewer.keyed = true
      viewer.waiting?.()
    }
    if (behind) this.#ask(preview, true)
  }

  #ack(watch: Watch): void {
    const send = () => {
      clearTimeout(watch.acking)
      watch.acking = undefined
      watch.acked = watch.received
      watch.media.ack(watch.received)
    }
    if (watch.received - watch.acked >= ACK_BYTES) return send()
    if (watch.acking) return
    watch.acking = setTimeout(send, ACK_MS)
    watch.acking.unref()
  }

  #ended(preview: Preview, watch: Watch, problem: Problem | undefined, error?: string): void {
    this.#close(preview, watch)
    const ending = controlVideoEnding(problem)
    if (ending === "lost") return this.#lost(preview, problem ? `${problem.title}${problem.detail ? `: ${problem.detail}` : ""}` : (error ?? "the stream closed"))
    preview.ended = ending
    if (ending === "failed") hostWarn("cloud-control-previews", "the machine stopped a preview's video", { conversationId: preview.conversationId, detail: problem?.detail })
    for (const viewer of preview.viewers.values()) viewer.waiting?.()
  }

  /** The link ended the watch, not the machine: opened again shortly, and after a few tries left until the agent acts. */
  #lost(preview: Preview, reason: string): void {
    if (this.#closed || this.#previews.get(preview.conversationId) !== preview) return
    if (preview.retries >= RETRIES) {
      hostWarn("cloud-control-previews", "a preview's video couldn't be watched; waiting for the agent to act", { conversationId: preview.conversationId, reason })
      preview.ended = "paused"
      for (const viewer of preview.viewers.values()) viewer.waiting?.()
      return
    }
    const wait = RETRY_MS * 2 ** preview.retries++
    preview.retry = setTimeout(() => {
      preview.retry = undefined
      this.#open(preview)
    }, wait)
    preview.retry.unref()
  }

  #close(preview: Preview, watch: Watch): void {
    if (preview.watch === watch) preview.watch = undefined
    clearTimeout(watch.acking)
    clearTimeout(watch.asking)
    watch.media.close()
  }

  #stop(preview: Preview): void {
    clearTimeout(preview.retry)
    preview.retry = undefined
    clearInterval(preview.sweep)
    preview.sweep = undefined
    if (preview.watch) this.#close(preview, preview.watch)
  }
}

/** `mako:control-video`: a window's viewer of a cloud conversation's preview reads its packets. */
export function declareCloudControlPreviewMethods(methods: MethodTable, previews: () => CloudControlPreviews | undefined): void {
  methods.handle("mako:control-video", async (conversationId: string, viewer: string, box?: { width: number; height: number }) =>
    encodeControlVideoBatch(await previews()?.read(conversationId, viewer, box) ?? { live: false, packets: [] }))
}

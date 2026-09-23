import { z } from "zod"
import { ControlRecording } from "./control-recording.js"
import type { BrowserConnection } from "./browser-connection.js"
import type { BrowserTarget } from "./contracts/browser-control.js"
import type { RecordingOptions } from "@mako/control/control"

const frame = z.object({
  sessionId: z.number(),
  data: z.string(),
  metadata: z.object({
    deviceWidth: z.number().positive(),
    deviceHeight: z.number().positive(),
    pageScaleFactor: z.number().positive(),
    offsetTop: z.number().finite(),
    timestamp: z.number().finite().optional(),
  }),
})
export class BrowserRecordings {
  private readonly pending = new Map<
    string,
    { owner: string; target: BrowserTarget; active: boolean }
  >()
  private readonly recordings = new Map<
    string,
    { owner: string; target: BrowserTarget; recording: ControlRecording }
  >()
  async start(
    owner: string,
    target: BrowserTarget,
    connection: Pick<
      BrowserConnection,
      "send" | "onEvent" | "onInput" | "onClose"
    >,
    sessionId: string,
    options: RecordingOptions,
    signal: AbortSignal
  ) {
    if (
      [...this.recordings.values()].some(
        (r) =>
          r.target.browser === target.browser &&
          r.target.tab === target.tab &&
          ["recording", "finalizing"].includes(r.recording.receipt().status)
      )
    )
      throw new Error("This tab is already recording")
    for (const [id, entry] of this.recordings) {
      if (this.recordings.size < 64) break
      if (
        ["finished", "interrupted", "failed"].includes(
          entry.recording.receipt().status
        )
      )
        this.recordings.delete(id)
    }
    if (this.recordings.size >= 64)
      throw new Error(
        "Recording history is full for this host; finish existing recordings first"
      )
    let ended = false
    let unsubscribe = () => {},
      uninput = () => {},
      unclose = () => {}
    const key = JSON.stringify(target)
    if (this.pending.has(key))
      throw new Error("This tab is already starting a recording")
    const admission = { owner, target, active: true }
    this.pending.set(key, admission)
    const recording = await ControlRecording.create(
      { kind: "page", ...target },
      options,
      async () => {
        uninput()
        try {
          if (ended) return
          try {
            await connection.send(
              "Page.stopScreencast",
              {},
              AbortSignal.timeout(2000),
              sessionId
            )
          } catch {
            if (ended) return
            // Stop is idempotent. Releasing this exact attachment is the final
            // cleanup path; never reconnect or replay an input operation.
            await connection.send(
              "Target.detachFromTarget",
              { sessionId },
              AbortSignal.timeout(2000)
            )
            return "Capture stop failed; the exact tab attachment was released to end recording"
          }
        } finally {
          unsubscribe()
          unclose()
        }
      }
    ).catch((error) => {
      this.pending.delete(key)
      throw error
    })
    if (!admission.active) {
      this.pending.delete(key)
      await recording.stop(
        "Task or tab lease ended while recording was starting"
      )
      throw new Error("Recording target lease ended before capture started")
    }
    this.recordings.set(recording.id, { owner, target, recording })
    unsubscribe = connection.onEvent((event) => {
      if (
        (event.method === "Target.detachedFromTarget" &&
          event.params.sessionId === sessionId) ||
        (event.method === "Target.targetDestroyed" &&
          event.params.targetId === target.tab)
      ) {
        ended = true
        void recording.stop("Recording target detached")
        return
      }
      if (event.sessionId !== sessionId) return
      if (event.method === "Page.screencastFrame") {
        const value = frame.safeParse(event.params)
        if (!value.success) {
          void recording.stop("The browser returned an invalid video frame")
          return
        }
        // Always acknowledge, including frames dropped under disk backpressure.
        void recording
          .frame(
            value.data.data,
            value.data.metadata.deviceWidth,
            value.data.metadata.deviceHeight,
            {
              pageScaleFactor: value.data.metadata.pageScaleFactor,
              offsetTop: value.data.metadata.offsetTop,
              capturedAt:
                value.data.metadata.timestamp === undefined
                  ? undefined
                  : value.data.metadata.timestamp * 1000,
            }
          )
          .finally(() => {
            void connection
              .send(
                "Page.screencastFrameAck",
                { sessionId: value.data.sessionId },
                AbortSignal.timeout(2000),
                sessionId
              )
              .catch(() => {})
          })
      }
    })
    uninput = connection.onInput((event) => {
      if (event.sessionId === sessionId) recording.pointer(event)
    })
    unclose = connection.onClose(() => {
      ended = true
      void recording.stop("Browser connection ended")
    })
    try {
      await connection.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: 90,
          maxWidth: options.maxSide ?? 1600,
          maxHeight: options.maxSide ?? 1600,
          everyNthFrame: 1,
        },
        signal,
        sessionId
      )
      if (!admission.active || recording.receipt().status !== "recording") {
        await connection
          .send("Page.stopScreencast", {}, AbortSignal.timeout(2000), sessionId)
          .catch(() => {})
        await recording.stop("Recording was stopped during startup")
        throw new Error("Recording ended during startup")
      }
      return recording.receipt()
    } catch (error) {
      await recording.stop("Browser recording could not start")
      throw error
    } finally {
      this.pending.delete(key)
    }
  }
  get(owner: string, target: BrowserTarget, id: string) {
    const entry = this.recordings.get(id)
    if (
      !entry ||
      entry.owner !== owner ||
      JSON.stringify(entry.target) !== JSON.stringify(target)
    )
      throw new Error("Recording does not belong to this target and task")
    return entry.recording
  }
  stopTarget(owner: string, target: BrowserTarget, reason: string) {
    for (const admission of this.pending.values())
      if (admission.owner === owner && admission.target.lease === target.lease)
        admission.active = false
    for (const entry of this.recordings.values())
      if (entry.owner === owner && entry.target.lease === target.lease)
        void entry.recording.stop(reason)
  }
  stopOwner(owner: string) {
    for (const admission of this.pending.values())
      if (admission.owner === owner) admission.active = false
    for (const entry of this.recordings.values())
      if (entry.owner === owner) void entry.recording.stop("Task ended")
  }
}

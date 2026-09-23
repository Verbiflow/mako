import type { BrowserCapture } from "./browser-capture.js"
import { ControlRecording } from "./control-recording.js"
import type { BrowserConnection } from "./browser-connection.js"
import type { BrowserTarget } from "./contracts/browser-control.js"
import type { RecordingOptions } from "@mako/control/control"

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
    signal: AbortSignal,
    capture: BrowserCapture
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
    let unsubscribe: (() => Promise<void>) | undefined
    let uninput = () => {}
    let frameReceived = () => {}
    let frameFailed: (error: Error) => void = () => {}
    const firstFrame = new Promise<void>((resolve, reject) => {
      frameReceived = resolve
      frameFailed = reject
    })
    // Teardown can arrive during asynchronous startup, before the caller awaits readiness.
    void firstFrame.catch(() => {})
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
          await unsubscribe?.()
        } catch (error) {
          return error instanceof Error ? error.message : "Capture stop failed"
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
    uninput = connection.onInput((event) => {
      if (event.sessionId === sessionId) recording.pointer(event)
    })
    try {
      signal.throwIfAborted()
      unsubscribe = await capture.subscribe({
        frame: (value) => {
          void recording
            .frame(value.data, value.viewportWidth, value.viewportHeight, {
              pageScaleFactor: value.pageScaleFactor,
              offsetTop: value.offsetTop,
              capturedAt: value.capturedAt,
            })
            .then(() => {
              if (recording.receipt().frames > 0) frameReceived()
              else if (recording.receipt().status !== "recording")
                frameFailed(
                  new Error("The first recording frame could not be stored")
                )
            })
        },
        ended: (reason) => {
          frameFailed(new Error(reason))
          void recording.stop(reason)
        },
      })
      if (!admission.active || recording.receipt().status !== "recording") {
        await unsubscribe()
        await recording.stop("Recording was stopped during startup")
        throw new Error("Recording ended during startup")
      }
      const onAbort = () =>
        frameFailed(new Error("Recording startup was cancelled"))
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
      const timeout = setTimeout(
        () =>
          frameFailed(
            new Error(
              "The browser supplied no video frames within five seconds. This tab may not be painting in the background. Capture was stopped; the tab was not activated or moved. For an owned headless browser, create a separate background window before recording."
            )
          ),
        5000
      )
      try {
        await firstFrame
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener("abort", onAbort)
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
  async finishOwner(owner: string) {
    this.stopOwner(owner)
    await Promise.all(
      [...this.recordings.values()]
        .filter((entry) => entry.owner === owner)
        .map((entry) => entry.recording.settled())
    )
  }
  stopOwner(owner: string) {
    for (const admission of this.pending.values())
      if (admission.owner === owner) admission.active = false
    for (const entry of this.recordings.values())
      if (entry.owner === owner) void entry.recording.stop("Task ended")
  }
}

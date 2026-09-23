import { randomUUID } from "node:crypto"
import WebSocket from "ws"
import { z } from "zod"
import { BrowserFault } from "./contracts/browser-control.js"
import type { JsonObject } from "./json.js"

const object = z.record(z.string(), z.json())
const messageSchema = z.object({
  id: z.number().int().optional(),
  sessionId: z.string().optional(),
  method: z.string().optional(),
  params: z.json().optional(),
  result: object.optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
})
export interface BrowserProtocolEvent {
  cursor: number
  sessionId?: string
  method: string
  params: JsonObject
}

/** Exactly one upstream connection. Requests are never retried or retargeted. */
const mousePointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
})

export class BrowserConnection {
  readonly generation = randomUUID()
  private sequence = 0
  private eventSequence = 0
  private readonly pending = new Map<
    number,
    {
      finish: (error: BrowserFault | null, value?: JsonObject) => void
    }
  >()
  private readonly listeners = new Set<(event: BrowserProtocolEvent) => void>()
  private readonly closedListeners = new Set<() => void>()

  private readonly inputListeners = new Set<
    (event: {
      sessionId?: string
      x: number
      y: number
      dispatchedAt: number
      pressed: boolean
    }) => void
  >()
  onInput(
    listener: (event: {
      sessionId?: string
      x: number
      y: number
      dispatchedAt: number
      pressed: boolean
    }) => void
  ) {
    this.inputListeners.add(listener)
    return () => {
      this.inputListeners.delete(listener)
    }
  }
  private readonly socket: WebSocket
  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on("message", (data) => {
      // One unreadable frame must not take down every task's binding; the
      // frame is dropped, and every request keeps its own timer.
      let value: z.infer<typeof messageSchema>
      try {
        value = messageSchema.parse(JSON.parse(data.toString()))
      } catch {
        return
      }
      if (value.id !== undefined) {
        const request = this.pending.get(value.id)
        if (!request) return
        request.finish(
          value.error
            ? new BrowserFault({
                code: "protocol-error",
                message: /detached while handling command/i.test(
                  value.error.message
                )
                  ? `${value.error.message} Read browser status for interruption details, and check the exact page before repeating this action.`
                  : value.error.message,
                // A debugger can detach after input has reached the renderer.
                // The protocol error is not proof that dispatch was rejected.
                outcome: /detached while handling command/i.test(
                  value.error.message
                )
                  ? "unknown"
                  : "rejected",
              })
            : null,
          value.result ?? {}
        )
      } else if (value.method) {
        const params = object.safeParse(value.params)
        const event = {
          cursor: ++this.eventSequence,
          sessionId: value.sessionId,
          method: value.method,
          params: params.success
            ? params.data
            : { value: value.params ?? null },
        }
        for (const listener of this.listeners) listener(event)
      }
    })
    socket.on("error", () => socket.terminate())
    socket.once("close", () => {
      for (const request of this.pending.values())
        request.finish(
          new BrowserFault({
            code: "disconnected",
            message:
              "Browser disconnected. Observe the target after reconnecting before deciding whether to retry.",
            outcome: "unknown",
          })
        )
      for (const listener of this.closedListeners) listener()
    })
  }

  static connect(
    endpoint: string,
    signal: AbortSignal
  ): Promise<BrowserConnection> {
    const url = new URL(endpoint)
    if (
      url.protocol !== "ws:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    )
      throw new BrowserFault({
        code: "invalid-request",
        message: "Browser connections must use a local endpoint.",
        outcome: "not-dispatched",
      })
    return new Promise((resolve, reject) => {
      signal.throwIfAborted()
      const socket = new WebSocket(url, {
        handshakeTimeout: 55_000,
        maxPayload: 32 * 1024 * 1024,
        perMessageDeflate: false,
      })
      const abort = () => {
        socket.terminate()
      }
      signal.addEventListener("abort", abort, { once: true })
      socket.once("error", (error) => {
        signal.removeEventListener("abort", abort)
        reject(
          new BrowserFault({
            code: "approval-required",
            message: `The browser did not accept Mako's local connection (${error.message}). For the Mako Browser extension, reload the extension in the browser and connect again; for a browser started with remote debugging, accept its debugging dialog first.`,
            outcome: "not-dispatched",
          })
        )
      })
      socket.once("open", () => {
        signal.removeEventListener("abort", abort)
        resolve(new BrowserConnection(socket))
      })
    })
  }

  /** Record something the host did on the browser's behalf, in cursor order with Chrome's own events. */
  emitLocal(method: string, params: JsonObject, sessionId?: string): void {
    const event = { cursor: ++this.eventSequence, sessionId, method, params }
    for (const listener of this.listeners) listener(event)
  }

  onEvent(listener: (event: BrowserProtocolEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onClose(listener: () => void): () => void {
    this.closedListeners.add(listener)
    return () => {
      this.closedListeners.delete(listener)
    }
  }

  send(
    method: string,
    params: JsonObject,
    signal: AbortSignal,
    sessionId?: string
  ): Promise<JsonObject> {
    if (signal.aborted || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new BrowserFault({
          code: signal.aborted ? "cancelled" : "disconnected",
          message: "Browser request was not dispatched.",
          outcome: "not-dispatched",
        })
      )
    const dispatchedAt = performance.now()
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const finish = (error: BrowserFault | null, result: JsonObject = {}) => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        if (error) reject(error)
        else {
          const point =
            method === "Input.dispatchMouseEvent"
              ? mousePointSchema.safeParse(params)
              : undefined
          if (point?.success)
            for (const listener of this.inputListeners) {
              try {
                listener({
                  sessionId,
                  dispatchedAt,
                  x: point.data.x,
                  y: point.data.y,
                  pressed: params.type === "mousePressed",
                })
              } catch {
                /* Media feedback cannot change the outcome of delivered input. */
              }
            }
          resolve(result)
        }
      }
      const abort = () =>
        finish(
          new BrowserFault({
            code: "cancelled",
            message:
              "Browser request cancelled after dispatch. Its outcome is unknown; observe before retrying.",
            outcome: "unknown",
          })
        )
      const timer = setTimeout(
        () =>
          finish(
            new BrowserFault({
              code: "timed-out",
              message:
                "Browser request timed out after dispatch. Its outcome is unknown; observe before retrying.",
              outcome: "unknown",
            })
          ),
        30_000
      )
      this.pending.set(id, { finish })
      signal.addEventListener("abort", abort, { once: true })
      this.socket.send(
        JSON.stringify({ id, method, params, sessionId }),
        (error) => {
          if (error)
            finish(
              new BrowserFault({
                code: "disconnected",
                message: "Browser transport failed during dispatch.",
                outcome: "unknown",
              })
            )
        }
      )
    })
  }

  close(): void {
    this.socket.terminate()
  }
}

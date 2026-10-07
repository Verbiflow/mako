import type { Actor, Operation, Reply } from "./envelope.js"
import type { EventFrame, Subscribe } from "./events.js"
import type { Json } from "./ids.js"
import type { GatewayFrame, RuntimeFrame } from "./runtime-frames.js"

/** One side of a connection: frames it sends, and the frames the other side sent, in order. */
export interface Link<Incoming, Outgoing> {
  send(frame: Outgoing): void
  /** Sends a value without checking it, to prove the other side refuses what isn't a frame. */
  sendUnchecked(value: Json): void
  /** The next frame from the other side; rejects if none arrives within `timeoutMs`. */
  next(timeoutMs?: number): Promise<Incoming>
  close(): void
  readonly closed: boolean
}

export type RuntimeLink = Link<GatewayFrame, RuntimeFrame>

export interface Subscription {
  next(timeoutMs?: number): Promise<EventFrame>
  close(): void
}

export interface ClientSession {
  /** Takes any JSON, so a gateway's validation can be tested; the reply says what happened. */
  call(operation: Operation | Json): Promise<Reply>
  subscribe(request: Subscribe): Subscription
}

/**
 * What the conformance suite drives. The fake gateway implements it in memory; the real gateway
 * implements it over its own transport, with `assign` on an operator-only route.
 */
export interface GatewayUnderTest {
  connectRuntime(): Promise<RuntimeLink>
  connectClient(actor: Actor): Promise<ClientSession>
  /** Gives a Thread to a runtime under a new generation, fencing whoever had it. Returns the generation. */
  assign(threadId: string, runtimeId: string): Promise<number>
  close(): Promise<void>
}

/** Frames waiting to be read, in arrival order. */
export class Inbox<T> {
  private readonly items: T[] = []
  private readonly waiters: Array<(item: T) => void> = []

  push(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  next(timeoutMs = 1_000): Promise<T> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve(item)
    return new Promise((resolve, reject) => {
      const waiter = (value: T) => {
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(new Error(`nothing arrived within ${timeoutMs} ms`))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }
}

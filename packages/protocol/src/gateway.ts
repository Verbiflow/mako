import type { Actor, Operation, Reply } from "./envelope.js"
import type { EventFrame, Subscribe } from "./events.js"
import type { Json } from "./ids.js"
import type { GatewayFrame, RuntimeFrame } from "./runtime-frames.js"

export class LinkClosedError extends Error {
  constructor() {
    super("The link to the gateway closed")
    this.name = "LinkClosedError"
  }
}

/** One side of a connection: frames it sends, and the frames the other side sent, in order. */
export interface Link<Incoming, Outgoing> {
  send(frame: Outgoing): void
  /** Sends a value without checking it, to prove the other side refuses what isn't a frame. */
  sendUnchecked(value: Json): void
  /**
   * The next frame from the other side. Rejects with `LinkClosedError` once the link has closed
   * and every frame sent before is read, or if `timeoutMs` passes first.
   */
  next(timeoutMs?: number): Promise<Incoming>
  /** Every frame, in order, until the link closes. */
  frames(): AsyncIterable<Incoming>
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

type Waiter<T> = { resolve(item: T): void; reject(error: Error): void }

/** Frames waiting to be read, in arrival order. Closing it lets what's queued be read, then ends. */
export class Inbox<T> {
  private readonly items: T[] = []
  private readonly waiters: Waiter<T>[] = []
  private ended = false

  get closed(): boolean {
    return this.ended
  }

  push(item: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(item)
    else this.items.push(item)
  }

  close(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0))
      waiter.reject(new LinkClosedError())
  }

  next(timeoutMs?: number): Promise<T> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve(item)
    if (this.ended) return Promise.reject(new LinkClosedError())
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waiter: Waiter<T> = {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      if (timeoutMs !== undefined)
        timer = setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          reject(new Error(`nothing arrived within ${timeoutMs} ms`))
        }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      try {
        yield await this.next()
      } catch (error) {
        if (error instanceof LinkClosedError) return
        throw error
      }
    }
  }
}

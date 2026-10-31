import type { Problem } from "./envelope.js"
import type { MediaDelivery, MediaStreamId } from "./media.js"

/**
 * SSH to a cloud Thread's machine through its links (version 15 on, `SSH_VERSION`): how a person's editor opens the
 * machine's checkout over SSH (`ProxyCommand mako ssh --stdio %h`) with no address of its own and nothing listening
 * for the internet. A stream of bytes each way between a client and the machine's SSH server, through the Thread:
 *
 * - The client names a stream (`ssh-open`) on its connection to the Thread; the gateway asks the runtime that runs the
 *   Thread to open it (`ssh-open` with the Thread), and the runtime connects to its machine's SSH server, on its own
 *   loopback and nowhere else. Once that server took the connection the runtime says `ssh-opened`, and the gateway
 *   tells the client, which sends nothing before it.
 * - Each side's bytes cross as binary media messages (`encodeMediaMessage`), the client's to the runtime as the
 *   runtime's come back, unread by the gateway.
 * - Each side says how many of the other's bytes it has taken (`media-ack`, counting each message's data), and sends
 *   at most `SSH_WINDOW_BYTES` the other hasn't said it took, so no hop holds more than a window each way whatever
 *   the network does.
 * - Either side ends it: the client with `media-unwatch` or by closing its connection, the runtime with `media-end`
 *   when its server closed, the gateway with `media-ended` when the runtime leaves.
 *
 * Nothing of it enters the Thread's stream.
 */

/** The most either side sends that the other hasn't said it took. */
export const SSH_WINDOW_BYTES = 1024 * 1024
/** The most one message carries, well inside a media message's limit. */
export const SSH_CHUNK_BYTES = 64 * 1024
/** A side says what it took once it has taken this much more: a keystroke's byte isn't acknowledged on its own. */
export const SSH_ACK_EVERY_BYTES = SSH_WINDOW_BYTES / 4

/** A client's SSH stream to the machine that runs `threadId`, under its own name. */
export type SshOpenRequest = { threadId: string; stream: MediaStreamId }

/** The stream ended before the machine's SSH server took it, and why. */
export class SshRefusedError extends Error {
  readonly problem: Problem | undefined
  constructor(reason: Problem | undefined) {
    super(reason ? (reason.detail ?? reason.title) : "The SSH stream ended before it opened")
    this.name = "SshRefusedError"
    this.problem = reason
  }
}

/** A client's side of one SSH stream. */
export interface SshStream {
  /** Settles once the machine's SSH server took the connection; rejects with `SshRefusedError` if it ended first. */
  readonly opened: Promise<void>
  /** The server's next bytes, or the stream's end, after which it rejects as a closed link. */
  next(timeoutMs?: number): Promise<MediaDelivery>
  /** Bytes for the server: sent once the stream opened, in pieces, as the window allows. */
  send(data: Uint8Array): void
  /** Settles once everything given to `send` went out: what a writer waits for before it gives more. */
  drained(): Promise<void>
  /** This many more of the server's bytes were taken (written out), so it may send more. */
  took(bytes: number): void
  /** Ends the stream; nothing more arrives. */
  close(): void
}

export interface SshClient {
  /**
   * Opens an SSH stream to the machine that runs the Thread. Its name is unique on the Thread: one this client has open
   * already is closed first, and one another client uses ends this one at once, as `conflict`.
   */
  ssh(request: SshOpenRequest): SshStream
}

/** How a runtime answers on one SSH stream. */
export interface SshSender {
  /** The machine's SSH server took the connection: the client may send. */
  opened(): void
  /** Bytes from the server; false once the stream ended or its link closed. Pace them with `SshOutgoing`. */
  send(data: Uint8Array): boolean
  /** This many more of the client's bytes were taken (written to the server). */
  took(bytes: number): void
  /** Ends the stream from the runtime's side; the client hears why. */
  end(problem?: Problem): void
}

/**
 * A runtime's SSH streams. Called in order for each stream: `open`, then any `data` and `acked`, then `closed` once,
 * unless the runtime ended it itself (`SshSender.end`).
 */
export interface SshHandler {
  /** A client asks for the SSH server of the machine that runs `threadId`. */
  open(stream: MediaStreamId, threadId: string, sender: SshSender): void
  /** The client's next bytes, in order. */
  data(stream: MediaStreamId, data: Uint8Array): void
  /** Every byte of the runtime's messages the client has taken so far. */
  acked(stream: MediaStreamId, received: number): void
  /** The client left, or the link closed: send nothing more on it. */
  closed(stream: MediaStreamId): void
}

/**
 * One direction's sending: bytes queued, then sent in pieces of at most `SSH_CHUNK_BYTES` while fewer than
 * `SSH_WINDOW_BYTES` wait to be taken. Every end of a stream sends through one, so the window holds at each.
 */
export class SshOutgoing {
  readonly #transmit: (piece: Uint8Array) => boolean
  readonly #queue: Uint8Array[] = []
  #queued = 0
  #sent = 0
  #acked = 0
  #held = true
  #closed = false
  #drained: Array<() => void> = []

  /** `transmit` sends one piece, false once it can't any more. Nothing goes until `release`. */
  constructor(transmit: (piece: Uint8Array) => boolean) {
    this.#transmit = transmit
  }

  /** Bytes given but not yet sent: a writer pauses its source while this is a chunk or more. */
  get queued(): number {
    return this.#queued
  }

  /** Sending may begin: the stream opened. */
  release(): void {
    this.#held = false
    this.#pump()
  }

  write(data: Uint8Array): void {
    if (this.#closed || !data.byteLength) return
    this.#queue.push(data)
    this.#queued += data.byteLength
    this.#pump()
  }

  /** The other side took `received` bytes in all. */
  acked(received: number): void {
    if (received <= this.#acked) return
    this.#acked = Math.min(received, this.#sent)
    this.#pump()
  }

  drained(): Promise<void> {
    if (this.#closed || !this.#queued) return Promise.resolve()
    return new Promise((resolve) => this.#drained.push(resolve))
  }

  close(): void {
    this.#closed = true
    this.#queue.length = 0
    this.#queued = 0
    this.#settle()
  }

  #pump(): void {
    while (!this.#held && !this.#closed && this.#queue.length && this.#sent - this.#acked < SSH_WINDOW_BYTES) {
      const head = this.#queue[0]!
      const room = Math.min(SSH_CHUNK_BYTES, SSH_WINDOW_BYTES - (this.#sent - this.#acked))
      const piece = head.byteLength <= room ? head : head.subarray(0, room)
      if (piece === head) this.#queue.shift()
      else this.#queue[0] = head.subarray(room)
      this.#queued -= piece.byteLength
      this.#sent += piece.byteLength
      if (!this.#transmit(piece)) return this.close()
    }
    if (!this.#queued) this.#settle()
  }

  #settle(): void {
    for (const resolve of this.#drained.splice(0)) resolve()
  }
}

/** One direction's taking: says how much it took in all, once at least `SSH_ACK_EVERY_BYTES` more. */
export class SshIncoming {
  readonly #say: (received: number) => void
  #taken = 0
  #said = 0

  constructor(say: (received: number) => void) {
    this.#say = say
  }

  took(bytes: number): void {
    this.#taken += bytes
    if (this.#taken - this.#said < SSH_ACK_EVERY_BYTES) return
    this.#said = this.#taken
    this.#say(this.#taken)
  }
}

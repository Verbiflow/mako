import { z } from "zod"
import type { Problem } from "./envelope.js"
import type { Payload } from "./payload.js"
import { WireError } from "./wire-error.js"

/**
 * Live media a client watches through a Thread, such as the browser an agent drives, on links of version 3 and
 * later (`MEDIA_VERSION`). It never enters the Thread's stream: nothing records, numbers, acknowledges or replays
 * it, and watching doesn't wake the Thread's machine or count as a person calling the Thread.
 *
 * - The client names the stream (`media-watch`) with a request for the runtime, which the gateway passes on unread.
 *   Sent again for the same stream, it changes what's watched, such as the size the viewer draws.
 * - The runtime answers with binary media messages: the stream's name, then its bytes, unread by the gateway too.
 * - The client says how many bytes it has taken (`media-ack`), which is how the runtime knows a slow viewer: a
 *   gateway can't see how much waits in another socket, and acknowledgements work across any number of hops.
 * - Either side ends it: the client with `media-unwatch` or by closing its connection, the runtime with
 *   `media-end`, the gateway with `media-ended` when the runtime leaves.
 */

/** A viewer's own name for its stream, unique on its Thread; a random UUID will do. */
export const MediaStreamIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
export type MediaStreamId = z.infer<typeof MediaStreamIdSchema>

/** The most a media message holds, its header included: within every hop's message limit. */
export const MEDIA_MESSAGE_LIMIT = 1024 * 1024
/** The stream's bytes after its name: `m`, the format's version, the name's length, then the name. */
const MAGIC = 0x6d
const FORMAT = 1

export class MediaTooLargeError extends Error {
  constructor(bytes: number) {
    super(`A media message of ${bytes} bytes is over the ${MEDIA_MESSAGE_LIMIT}-byte limit`)
    this.name = "MediaTooLargeError"
  }
}

export function encodeMediaMessage(stream: MediaStreamId, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const name = new TextEncoder().encode(MediaStreamIdSchema.parse(stream))
  const length = 3 + name.byteLength + data.byteLength
  if (length > MEDIA_MESSAGE_LIMIT) throw new MediaTooLargeError(length)
  const message = new Uint8Array(length)
  message[0] = MAGIC
  message[1] = FORMAT
  message[2] = name.byteLength
  message.set(name, 3)
  message.set(data, 3 + name.byteLength)
  return message
}

/** The stream a message is for, read from its header alone: what a hop routes by. */
export function mediaStreamOf(message: Uint8Array): MediaStreamId {
  if (message.byteLength > MEDIA_MESSAGE_LIMIT) throw new WireError(`A media message of ${message.byteLength} bytes is over the limit`)
  if (message.byteLength < 3 || message[0] !== MAGIC) throw new WireError("Not a media message")
  if (message[1] !== FORMAT) throw new WireError(`Media format ${message[1]} isn't one this build reads`)
  const end = 3 + message[2]!
  if (message.byteLength < end) throw new WireError("A media message ends inside its stream's name")
  let name = ""
  for (let index = 3; index < end; index++) name += String.fromCharCode(message[index]!)
  const stream = MediaStreamIdSchema.safeParse(name)
  if (!stream.success) throw new WireError("A media message names no valid stream")
  return stream.data
}

export type MediaMessage = { stream: MediaStreamId; data: Uint8Array }

/** The stream and its bytes, as a view into the message. */
export function decodeMediaMessage(message: Uint8Array): MediaMessage {
  const stream = mediaStreamOf(message)
  return { stream, data: message.subarray(3 + stream.length) }
}

/** A socket's binary message as bytes, whether its runtime delivers an ArrayBuffer or a Node Buffer; a Blob isn't one. */
export const BinaryMessageSchema = z.union([
  z.instanceof(ArrayBuffer).transform((buffer) => new Uint8Array(buffer)),
  z.instanceof(Uint8Array),
])

/** What a watching client reads, in order: the stream's messages, then its end. */
export type MediaDelivery = { kind: "data"; data: Uint8Array } | { kind: "ended"; problem?: Problem }

export type MediaWatchRequest = {
  threadId: string
  stream: MediaStreamId
  /** For the runtime that serves the stream, which owns its format; the gateway passes it on unread. */
  request: Payload
}

export interface MediaWatch {
  /** The next message, or the stream's end, after which it rejects as a closed link. */
  next(timeoutMs?: number): Promise<MediaDelivery>
  /** Asks again for the same stream with a new request, such as another size. */
  update(request: Payload): void
  /** Every byte of the stream's messages taken so far, counting each message's data. */
  ack(received: number): void
  /** Stops watching; nothing more arrives. */
  close(): void
}

/** How a runtime sends on one stream it serves. */
export interface MediaSender {
  /** One message of the stream; false once it ended or its link closed. Throws `MediaTooLargeError` for one over the limit. */
  send(data: Uint8Array): boolean
  /** Ends the stream from the runtime's side; its viewer hears why. */
  end(problem?: Problem): void
}

/**
 * A runtime's streams. Called in order for each stream: `watch`, then any `watch` again and `acked`, then `unwatched`
 * once, unless the runtime ended the stream itself (`MediaSender.end`).
 */
export interface MediaHandler {
  /** A client watches `stream` of a Thread this runtime runs; again for the same stream when the client changes `request`. */
  watch(stream: MediaStreamId, threadId: string, request: Payload, sender: MediaSender): void
  acked(stream: MediaStreamId, received: number): void
  /** The viewer stopped watching, left, or the link closed: send nothing more on it. */
  unwatched(stream: MediaStreamId): void
}

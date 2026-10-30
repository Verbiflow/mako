import { z } from "zod"
import type { MediaSender, MediaStreamId } from "./media.js"
import { WireError } from "./wire-error.js"

/**
 * A request to an app a runtime serves on one of its ports, or for one of the files its host signed, made through the
 * runtime's own link (version 7 on, `PORTS_VERSION`): how a person's phone opens the website a Thread's app serves on
 * their Mac or its machine, and the screenshots and recordings in its transcript, with no tunnel and nothing listening
 * on the Mac's network.
 *
 * - The gateway sends `port-open` with the request's line, headers and body; the runtime makes it to the port on its own
 *   loopback, and only to a port one of its Threads' apps serves on, or answers it from its own signed files
 *   (`/file/asset/…`, each URL a capability its host issued for one file).
 * - The answer comes back on the request's stream as media messages (`media.ts`): first its head (status and headers,
 *   as JSON), then its body's bytes, then `media-end`. The gateway acknowledges what it has passed on (`media-ack`), so
 *   a slow phone slows the runtime, and stops the stream (`media-unwatch`) when the phone goes away.
 */

/** The most a request's body carries: it crosses in one frame, under every hop's message limit. */
export const PORT_BODY_LIMIT = 512 * 1024

const HeaderSchema = z.tuple([z.string().min(1).max(256), z.string().max(8_192)])

/** What a port request is for: an app's port on the runtime's loopback, or the runtime's own signed files. */
export const PortTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("port"), port: z.number().int().min(1).max(65_535) }).strict(),
  z.object({ kind: z.literal("files") }).strict(),
])
export type PortTarget = z.infer<typeof PortTargetSchema>

export const PortRequestSchema = z
  .object({
    to: PortTargetSchema,
    method: z.string().regex(/^[A-Z]{3,10}$/),
    /** The path and query, from its first `/`. */
    path: z.string().startsWith("/").max(8_192),
    headers: z.array(HeaderSchema).max(200),
    /** The body, base64, when it has one. */
    body: z.string().max(Math.ceil(PORT_BODY_LIMIT / 3) * 4).optional(),
  })
  .strict()
export type PortRequest = z.infer<typeof PortRequestSchema>

/** The first message of a port request's stream: the answer's status and headers. */
export const PortHeadSchema = z.object({ status: z.number().int().min(100).max(599), headers: z.array(HeaderSchema).max(200) }).strict()
export type PortHead = z.infer<typeof PortHeadSchema>

export function encodePortHead(head: PortHead): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(PortHeadSchema.parse(head)))
}

export function decodePortHead(data: Uint8Array): PortHead {
  try {
    return PortHeadSchema.parse(JSON.parse(new TextDecoder().decode(data)))
  } catch (error) {
    throw new WireError(`A port answer's head isn't one: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * A runtime's port requests. Called in order for each stream: `open`, then any `acked`, then `closed` once, unless the
 * runtime ended the stream itself (`MediaSender.end`).
 */
export interface PortHandler {
  open(stream: MediaStreamId, request: PortRequest, sender: MediaSender): void
  acked(stream: MediaStreamId, received: number): void
  /** The gateway stopped the request (its phone went away) or the link closed: send nothing more on it. */
  closed(stream: MediaStreamId): void
}

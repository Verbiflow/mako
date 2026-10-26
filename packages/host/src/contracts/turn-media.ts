import type { MediaKind } from "@mako/sessions/turn-media"

/**
 * A call's id in its harness, which keys what the host decided about a file
 * it made: the same live and saved, so a reopened conversation asks nothing
 * of the disk again.
 * @wire z.string().min(1).max(512)
 */
type CallId = string

/**
 * A file a turn's records name, absolute.
 * @wire z.string().min(2).max(4_096).startsWith("/")
 */
type MediaPath = string

/**
 * When a call started or ended, in epoch milliseconds.
 * @wire z.number().int().nonnegative().max(8_640_000_000_000_000)
 */
type Instant = number

/**
 * The SHA-256 of a copy the host kept, as hex.
 * @wire z.string().regex(/^[a-f0-9]{64}$/)
 */
type Digest = string

/**
 * One file a turn's records say the turn made or showed (`MediaCandidate`
 * in `@mako/sessions/turn-media`), for the host to confirm and keep. An
 * attachment the call returned as bytes needs no check.
 */
export interface MediaCheck {
  callId: CallId
  path: MediaPath
  /** How the records say it came about: `named` is only evidence, kept when the file changed while the call ran. */
  evidence: "shown" | "produced" | "wrote" | "named"
  startedAt?: Instant
  endedAt?: Instant
  /** The copy `show` kept, when its result said; for a file the turn's record of changes names, the content the turn left. */
  digest?: Digest
}

/**
 * A turn's checks, answered in one call, in order.
 * @wire z.array(z.object({ callId: z.string().min(1).max(512), path: z.string().min(2).max(4_096).startsWith("/"), evidence: z.enum(["shown", "produced", "wrote", "named"]), startedAt: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(), endedAt: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(), digest: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(200)
 */
export type MediaChecks = MediaCheck[]

/** A file the turn made, as the host kept it. */
export interface KeptMedia {
  /** Where the turn wrote it. */
  path: string
  /**
   * The bytes the turn made, whatever has happened at `path` since: Mako's
   * copy, or `path` itself for a video too large to copy (no `digest`).
   */
  file: string
  digest?: string
  kind: MediaKind
  mimeType: string
  bytes: number
  /** An image's or a video's size in pixels, where the header says. */
  width?: number
  height?: number
}

/**
 * What the host made of one check: kept; dropped, with why (no such file,
 * not media, older than the call, changed since); or not known yet, for a
 * call still running whose file may not exist yet.
 */
export type MediaConfirmation =
  | { kind: "kept"; media: KeptMedia }
  | { kind: "dropped"; reason: string }
  | { kind: "pending" }

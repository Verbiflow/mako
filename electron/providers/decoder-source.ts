import type { JsonObject, JsonValue } from "../codex-app-json.js"
import type { Decoded } from "../contracts/native-decoding.js"
import type { ProviderCapability } from "./registry.js"

/** A driver-only fact, as tools see it: named by its `type`. */
export interface DecoderEffect {
  type: string
}

/**
 * A harness's decoder, offered to Mako's tools. The live driver decodes
 * messages as they arrive; this lets the fixture runner
 * (`npm run test:decoders`), the decode tool (`npm run decode`) and the
 * coverage report run the same decoder over recorded messages, with no
 * harness process.
 */
export interface ProviderDecoderSource extends ProviderCapability {
  /** Message kinds the decoder translates. */
  decoded: ReadonlySet<string>
  /** Kinds it knows and deliberately shows nothing for. */
  silent: ReadonlySet<string>
  /** The kind one recorded message carries; what coverage counts. */
  kind(message: JsonValue): string
  /**
   * How the harness's own tables class a message the two lists cannot name
   * ahead, such as an ACP agent's vendor notifications; `undefined` leaves it
   * to the lists.
   */
  declares?(message: JsonValue): "decoded" | "silent" | undefined
  /**
   * A decoder for one recorded session. `session` holds what the driver
   * knew before the first message arrived (for Codex, the thread id).
   */
  open(session: JsonObject): RecordedDecoder
}

export interface RecordedDecoder {
  decode(message: JsonValue): Decoded<DecoderEffect>[]
  /** A turn opened where the capture says so, for a decoder whose driver starts one per turn. */
  prompted?(): void
  /**
   * A resumed session's process starting where the capture says so: until
   * `opened`, what it reports is its history replayed, whose spend was
   * counted when it happened.
   */
  opening?(): void
  opened?(): void
}

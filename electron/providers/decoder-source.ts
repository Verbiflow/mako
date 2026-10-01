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
   * A decoder for one recorded session. `session` holds what the driver
   * knew before the first message arrived (for Codex, the thread id).
   */
  open(session: JsonObject): RecordedDecoder
}

export interface RecordedDecoder {
  decode(message: JsonValue): Decoded<DecoderEffect>[]
}

import type { Json } from "@mako/protocol"
import { HOST_FAILURE_KINDS, PROVIDER_FAILURE_KINDS, type ProviderFailureKind } from "./provider-failure.js"
import { z } from "zod"

/** A verdict with its origin: typed host facts, native protocol facts, or text admitted by a native transport. */
const CurrentFailureEvidenceSchema = z.union([
  z.object({ kind: z.literal("rate-limited"), source: z.literal("native-limit") }),
  z.object({ kind: z.enum(PROVIDER_FAILURE_KINDS), source: z.literal("native-error") }),
  z.object({ kind: z.enum(HOST_FAILURE_KINDS), source: z.literal("host") }),
  z.object({ kind: z.enum(PROVIDER_FAILURE_KINDS), source: z.literal("provider-text") }),
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("auth"), source: z.enum(["credential-missing", "refresh-failed", "provider-auth-error"]) }),
    z.object({ kind: z.literal("permission"), source: z.literal("provider-permission-error") }),
    z.object({ kind: z.literal("unknown"), source: z.literal("provider-error") }),
    z.object({ kind: z.literal("provider-unavailable"), source: z.enum(["credential-current", "gateway-response", "unconfirmed-auth"]) }),
  ]),
])
/** Older journals read the fallback; current readers recover its exact origin/kind. */
const ExactFailureEvidenceSchema = z.object({ exact: CurrentFailureEvidenceSchema })
const UnknownExactFailureSchema = z.object({ exact: z.unknown().refine(value => value !== undefined) })
export const ProviderFailureEvidenceSchema = z.preprocess(value => {
  const exact = ExactFailureEvidenceSchema.safeParse(value)
  return exact.success ? exact.data.exact : UnknownExactFailureSchema.safeParse(value).success ? { kind: "unknown", source: "host" } : value
}, CurrentFailureEvidenceSchema)
export type ProviderFailureEvidence = z.infer<typeof ProviderFailureEvidenceSchema>

/** Existing binaries can parse the request/session without knowing the new evidence variants. */
export function storedFailureEvidence(evidence: ProviderFailureEvidence) {
  return evidence.source === "host" || evidence.source === "provider-text" || evidence.source === "native-limit" || evidence.source === "native-error"
    ? { kind: "unknown" as const, source: "provider-error" as const, exact: evidence }
    : evidence
}

/** Failure kinds older builds don't know, each saved as the one they read, with the exact one beside it (as `OLDER_READING` does for reasons). */
const OLDER_FAILURE_READING = { "model-refusal": "unknown" } as const satisfies Partial<Record<ProviderFailureKind, ProviderFailureKind>>
/** A request's or failed transfer's `failure` as its row keeps it (`savedFailure`, `readStoredFailure`). */
export const StoredFailureFields = { failure: z.enum(PROVIDER_FAILURE_KINDS).optional(), exactFailure: z.string().optional() }
export function savedFailure(failure: ProviderFailureKind | undefined): { failure?: ProviderFailureKind; exactFailure?: ProviderFailureKind } {
  return failure === "model-refusal" ? { failure: OLDER_FAILURE_READING[failure], exactFailure: failure } : { failure }
}
/** The kind a journal kept: its exact one when this build knows it, else the one every build reads. */
export function readStoredFailure<Fields extends { failure?: ProviderFailureKind | undefined; exactFailure?: string | undefined }>(fields: Fields): Fields {
  if (fields.exactFailure === undefined) return fields
  const { exactFailure, ...rest } = fields
  const exact = PROVIDER_FAILURE_KINDS.find((kind) => kind === exactFailure)
  // SAFETY: `rest` is `fields` less the optional `exactFailure`, and `failure` stays a ProviderFailureKind or undefined, so it is still a `Fields`.
  return { ...rest, failure: exact ?? fields.failure } as Fields
}

/** A JSON object as revived, its fields kept. */
const JsonObjectSchema = z.record(z.string(), z.custom<Json>(() => true))
/** The kinds older builds don't know, as they're written in JSON: text without one needs no walk. */
const NEWER_KIND_TEXT = Object.keys(OLDER_FAILURE_READING).map((kind) => JSON.stringify(kind))
/** An object (a request, a failed transfer's state) whose `failure` is a kind older builds don't know. */
const NewerFailureSchema = z.looseObject({ failure: z.literal("model-refusal"), exactFailure: z.string().optional() })
/** An object (a request, a session) whose evidence names a kind older builds don't know, not yet saved beside one they do. */
const NewerEvidenceSchema = z.looseObject({ failureEvidence: z.object({ kind: z.literal("model-refusal"), source: z.string() }).loose() })

/** One JSON value, as `JSON.parse` revives it from the leaves up: a newer kind or evidence saved as older builds read it. */
function olderReadableValue(_key: string, value: Json): Json {
  const failed = NewerFailureSchema.safeParse(value)
  const revived: Json = failed.success && failed.data.exactFailure === undefined ? { ...JsonObjectSchema.parse(value), ...savedFailure(failed.data.failure) } : value
  const evidenced = NewerEvidenceSchema.safeParse(revived)
  if (!evidenced.success) return revived
  const evidence = ProviderFailureEvidenceSchema.safeParse(evidenced.data.failureEvidence)
  return evidence.success ? { ...JsonObjectSchema.parse(revived), failureEvidence: storedFailureEvidence(evidence.data) } : revived
}

/**
 * A value's JSON as it leaves this host for another device (through the gateway: a phone, a browser, another Mac),
 * whose build may predate a failure kind: an older build's window failed on a kind it didn't know (`acp-live.ts`'s
 * `failureDetail` reads `.title` off `describeProviderFailure`), so such a kind goes as `unknown` with the exact one
 * beside it, as a journal keeps it (`savedFailure`, `storedFailureEvidence`), and a reader that knows it reads it back
 * (`requestsAfter`, `sessionAfter`). Nothing yet tells this host which readers know it, so every one of them gets it
 * so; this host's own windows, its own build, read the exact kind. Text with no such kind is returned as it is.
 */
export function olderReadable(text: string): string
export function olderReadable(text: string | undefined): string | undefined
export function olderReadable(text: string | undefined): string | undefined {
  if (text === undefined || !NEWER_KIND_TEXT.some((kind) => text.includes(kind))) return text
  return JSON.stringify(JSON.parse(text, olderReadableValue))
}

/** An object sent with an exact kind beside the reading every build knows (`olderReadable`). */
const SentExactSchema = z.looseObject({ exactFailure: z.string() })
/** An object whose evidence was sent beside the reading every build knows (`storedFailureEvidence`). */
const SentEvidenceSchema = z.looseObject({ failureEvidence: z.looseObject({ exact: z.custom<Json>(() => true) }) })

/** One JSON value as `JSON.parse` revives it: a kind and evidence sent for older readers, taken back exactly. */
function exactValue(_key: string, value: Json): Json {
  const sent = SentExactSchema.safeParse(value)
  let revived: Json = value
  if (sent.success) {
    const { exactFailure, ...rest } = JsonObjectSchema.parse(value)
    const exact = PROVIDER_FAILURE_KINDS.find((kind) => kind === exactFailure)
    revived = exact ? { ...rest, failure: exact } : value
  }
  const evidenced = SentEvidenceSchema.safeParse(revived)
  if (!evidenced.success) return revived
  const evidence = ProviderFailureEvidenceSchema.safeParse(evidenced.data.failureEvidence)
  return evidence.success ? { ...JsonObjectSchema.parse(revived), failureEvidence: evidence.data } : revived
}

/**
 * Another device's answer as this build reads it: what its host sent for readers that may predate a kind
 * (`olderReadable`) carries the exact kind beside the reading every build knows, which this build takes back, so a
 * conversation read whole (a snapshot, a page of history) says what a batch of it does (`exactFailures`). Text with
 * nothing sent so is returned as it is.
 */
export function exactReadable(text: string | undefined): string | undefined {
  if (text === undefined || (!text.includes('"exactFailure":') && !text.includes('"exact":{"kind"'))) return text
  return JSON.stringify(JSON.parse(text, exactValue))
}

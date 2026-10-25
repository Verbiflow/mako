import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { zstdDecompressSync } from "node:zlib"
import { z } from "zod"
import { rolloutRecords } from "@mako/host/harnesses/codex/rollout-tail"
import type { JsonObject, JsonValue } from "@mako/host/contracts/json"
import type { Decoded } from "@mako/host/contracts/native-decoding"
import type { DecoderEffect, ProviderDecoderSource, RecordedDecoder } from "@mako/host/harnesses/decoder-source"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { compareVersions } from "@mako/host/contracts/runtime-version"
import { NativeEventSourceSchema, TurnCauseSchema } from "@mako/sessions/events"

const nativeStores = new NativeStores(false)

const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))

/**
 * Recorded native sessions and what each message decodes to, shared by the
 * fixture runner (`test-native-decoders.ts`) and the decode tool
 * (`decode-native.ts`).
 *
 * A fixture is `fixtures/native-decoding/<harness>/<name>.json`: where the
 * messages came from (`source` in prose, `native` as the version and origin
 * tools compare), what the driver knew before the first one (`session`),
 * and steps pairing each native message with the events it decodes to, in
 * order, so a review reads the message beside its meaning.
 */
export const FIXTURE_ROOT = join(import.meta.dirname, "fixtures", "native-decoding")

const PairVersion = z.object({ native: z.object({ version: z.string() }) })

/**
 * The versions a harness's current decode pairs were recorded with, each once, oldest first. A pair replays its capture
 * through the decoder beside the store the same session wrote, and the daily bump records them again; one kept from
 * another build is `<scenario>@<version>`, and isn't current.
 */
export async function currentPairVersions(harness: string, root = FIXTURE_ROOT): Promise<string[]> {
  const folder = join(root, harness, "pairs")
  const versions = new Set<string>()
  for (const name of (await readdir(folder).catch(() => [])).filter((entry) => !entry.includes("@"))) {
    const text = await readFile(join(folder, name, "pair.json"), "utf8").catch(() => null)
    if (text !== null) versions.add(PairVersion.parse(JSON.parse(text)).native.version)
  }
  return [...versions].sort(compareVersions)
}

/** A key set to `undefined` (a state patch clearing it) has no JSON form; fixtures spell it out. */
export const UNSET = "(undefined)"

const JsonSchema = z.json()
const JsonObjectSchema = z.record(z.string(), JsonSchema)
/** Built once: `z.json()` builds its lazy union per call, which cost more than the decoding it checked. */
const DecodedSchema = z.array(JsonSchema)

const VersionSchema = z.string().regex(/^\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/, "is not a version such as 0.159.0")

export const SdkSchema = z.object({ name: z.string().min(1), version: VersionSchema })

/**
 * What the messages came from. `version` is the harness runtime's own
 * version: the CLI, or the SDK when sessions run inside it (Cursor). It is
 * null only for a fixture written from a protocol's schema alone, which names
 * that schema's package as `sdk`. `captured` messages came from a real
 * session; `written` ones were authored from a schema or recorded shapes.
 */
export const FixtureNativeSchema = z.object({
  version: VersionSchema.nullable(),
  sdk: SdkSchema.optional(),
  origin: z.enum(["captured", "written"]),
}).strict()
  .refine((native) => native.version !== null || native.origin === "written", "a captured fixture names the version it was captured from")
  .refine((native) => native.version !== null || native.sdk, "a fixture with no harness version names the SDK whose schema it was written from")
export type FixtureNative = z.infer<typeof FixtureNativeSchema>

export const FIXTURE_NATIVE_HINT =
  'every fixture says what it records: "native": { "version": "0.159.0", "sdk"?: { "name", "version" }, "origin": "captured" | "written" }'

export const FixtureSchema = z.object({
  harness: z.string(),
  source: z.string(),
  native: FixtureNativeSchema,
  about: z.string(),
  session: JsonObjectSchema.default({}),
  steps: z.array(z.object({ message: z.json(), decoded: z.array(z.json()).optional() })).min(1),
})
export type Fixture = z.infer<typeof FixtureSchema>

/** A provider-started turn's opener, as the live update carries it. */
const ProviderTurnSchema = z.object({
  reason: z.string(),
  cause: TurnCauseSchema.optional(),
  body: z.string().optional(),
  source: NativeEventSourceSchema.optional(),
})

/** A stream's first line, written by `packages/host/src/harnesses/native-stream.ts`. */
const CaptureHeaderSchema = z.object({
  capture: z.number(),
  harness: z.string(),
  session: JsonObjectSchema,
  native: z.object({ version: VersionSchema, sdk: SdkSchema.optional() }).optional(),
})
const CaptureLineSchema = z.union([
  z.object({ message: z.json(), at: z.string().optional() }),
  z.object({ prompted: z.literal(true), compaction: z.literal(true).optional(), text: z.string().optional(), shown: z.string().optional(), shownAt: z.string().optional(), run: z.string().optional(), attachments: z.array(z.object({ name: z.string(), mimeType: z.string() })).optional(), turn: ProviderTurnSchema.optional() }),
  z.object({ steered: z.literal(true), text: z.string(), shown: z.string().optional() }),
  z.object({ opening: z.literal(true) }),
  z.object({ opened: z.literal(true) }),
  z.object({ drawn: JsonObjectSchema }),
  z.object({ closed: z.literal(true) }),
])

export function decoders(): ProviderDecoderSource[] {
  return providerHost.decoders.list()
}

export function decoderFor(harness: string): ProviderDecoderSource {
  const source = providerHost.decoders.get(harness)
  if (source) return source
  throw new Error(`No harness named ${harness}. Decoders: ${decoders().map((decoder) => decoder.provider).join(", ")}`)
}

/** Decoded events as fixtures hold them. */
export function recorded(events: Decoded<DecoderEffect>[]): JsonValue[] {
  const parsed = DecodedSchema.safeParse(JSON.parse(JSON.stringify(events, (_key, value) => value === undefined ? UNSET : value)))
  if (!parsed.success) throw new Error(`Decoded events are not JSON: ${parsed.error.message}`)
  return parsed.data
}

export interface DecodedStep {
  kind: string
  message: JsonValue
  decoded: JsonValue[]
}

/** Runs one recorded session through a fresh decoder. */
export function decodeSession(source: ProviderDecoderSource, session: JsonObject, messages: JsonValue[]): DecodedStep[] {
  const decoder = source.open(session)
  return messages.map((message) => ({ kind: source.kind(message), message, decoded: recorded(decoder.decode(message)) }))
}

export interface FixtureFile {
  path: string
  name: string
  fixture: Fixture
}

export interface InvalidFixture {
  path: string
  name: string
  problem: string
}

export interface LoadedFixtures {
  files: FixtureFile[]
  invalid: InvalidFixture[]
}

export async function loadFixtures(harness?: string, root = FIXTURE_ROOT): Promise<LoadedFixtures> {
  const harnesses = harness ? [harness] : await readdir(root).catch(() => [])
  const loaded: LoadedFixtures = { files: [], invalid: [] }
  for (const folderName of harnesses.sort()) {
    const folder = join(root, folderName)
    const entries = await readdir(folder).catch(() => [])
    for (const entry of entries.filter((file) => file.endsWith(".json")).sort()) {
      const path = join(folder, entry)
      const name = `${folderName}/${entry.slice(0, -".json".length)}`
      let json: unknown
      try {
        json = JSON.parse(await readFile(path, "utf8"))
      } catch (error) {
        loaded.invalid.push({ path, name, problem: `is not JSON: ${error instanceof Error ? error.message : String(error)}` })
        continue
      }
      const parsed = FixtureSchema.safeParse(json)
      if (parsed.success) loaded.files.push({ path, name, fixture: parsed.data })
      else {
        const native = parsed.error.issues.some((issue) => issue.path[0] === "native") ? `\n${FIXTURE_NATIVE_HINT}` : ""
        loaded.invalid.push({ path, name, problem: `is not a decoding fixture:\n${z.prettifyError(parsed.error)}${native}` })
      }
    }
  }
  return loaded
}

export interface Recording {
  harness?: string
  /** What the recording says about its origin: a fixture's `native`, or a capture's header. */
  native?: Partial<FixtureNative>
  session: JsonObject
  messages: JsonValue[]
  prompts?: Prompt[]
  /** Each launch that resumed the session, in order. */
  openings?: Opening[]
  /** What the host drew that no decoder draws (`NativeStream.drawn`), before the message at `at`. */
  drawn?: { at: number; update: JsonObject; frame?: Frame }[]
  /** Where Mako closed the session (`NativeStream.closed`): the messages from here reached no view. */
  closed?: number
  /** A capture's: the bytes of each message's line, as the recorder handed them to what it decoded into (`NativeStream.record`). */
  frames?: Frame[]
  /** A capture's: when each message arrived, its line's `at`, which the host measures by (`frameTime`). */
  times?: number[]
}

/** A line of a capture, `[from, to)` with its newline. */
export type Frame = [number, number]

/**
 * A launch resuming the session from the message at `at`: what the harness
 * sent from there until the session was open, before `opened`, is history it
 * replayed, which Mako's host doesn't draw (`drawnWhileOpening`).
 */
export interface Opening {
  at: number
  /** Where the session was open; absent when the capture ends first. */
  opened?: number
}

/** A turn Mako opened, or a message it steered into the running one, before the message at `at`. */
export interface Prompt {
  at: number
  /** What Mako drew for it; a turn the harness opened itself has none. */
  text?: string
  /** The harness's id for the turn, where Mako names it before sending; a native rewind names it. */
  run?: string
  /** What Mako drew under the prompt: each attachment's name and type. */
  attachments?: PromptFile[]
  steered?: true
  /** A turn the harness opened itself, with the cause the host drew for it (`CapturedPrompt.turn`). */
  turn?: z.infer<typeof ProviderTurnSchema>
  /** A compaction Mako asked for (`StreamedPrompt.compaction`). */
  compaction?: true
  /** A capture's: its line. */
  frame?: Frame
  /** Where Mako drew it, before the message at this index, where that was before it was sent (`StreamedPrompt.shownAt`). */
  drawnAt?: number
}

export interface PromptFile {
  name: string
  mimeType: string
}

/**
 * Each message of a recording with what `decoder` makes of it, told where Mako
 * opened a turn and where a resumed session was opening, as the host tells its driver.
 */
export function* replayed(decoder: RecordedDecoder, recording: Recording): Generator<{ message: JsonValue; decoded: Decoded<DecoderEffect>[] }> {
  const prompts = recording.prompts ?? []
  const openings = recording.openings ?? []
  let next = 0
  for (const [index, message] of recording.messages.entries()) {
    for (; prompts[next]?.at === index; next++) if (!prompts[next]!.steered) decoder.prompted?.(prompts[next]!.compaction && { compaction: true })
    for (const opening of openings) {
      if (opening.at === index) decoder.opening?.()
      if (opening.opened === index) decoder.opened?.()
    }
    yield { message, decoded: decoder.decode(message) }
  }
}

/** Messages from a capture, a fixture, or a file of one native message per line. */
export async function readRecording(path: string): Promise<Recording> {
  const text = await readFile(path, "utf8")
  if (path.endsWith(".json")) {
    const fixture = FixtureSchema.parse(JSON.parse(text))
    return { harness: fixture.harness, native: fixture.native, session: fixture.session, messages: fixture.steps.map((step) => step.message) }
  }
  const places: Frame[] = []
  const lines: string[] = []
  let offset = 0
  for (const line of text.split("\n")) {
    const end = offset + Buffer.byteLength(line) + 1
    if (line.trim()) {
      lines.push(line)
      places.push([offset, end])
    }
    offset = end
  }
  const rollouts = new Map<string, Promise<Buffer>>()
  const header = CaptureHeaderSchema.safeParse(JSON.parse(lines[0] ?? "null"))
  const body = header.success ? lines.slice(1) : lines
  const bodyPlaces = header.success ? places.slice(1) : places
  const frames: Frame[] = []
  const times: number[] = []
  const messages: JsonValue[] = []
  const prompts: Prompt[] = []
  const openings: Opening[] = []
  const drawn: { at: number; update: JsonObject; frame?: Frame }[] = []
  let closed: number | undefined
  for (const [index, line] of body.entries()) {
    const frame = bodyPlaces[index]!
    const value = JsonSchema.parse(JSON.parse(line))
    if (!header.success) {
      messages.push(value)
      continue
    }
    const captured = CaptureLineSchema.safeParse(value)
    if (!captured.success) continue
    const kept = captured.data
    if ("message" in kept) {
      messages.push(await withRolloutRecords(kept.message, rollouts))
      frames.push(frame)
      times.push(kept.at === undefined ? Number.NaN : Date.parse(kept.at))
      continue
    }
    if ("opening" in kept) {
      openings.push({ at: messages.length })
      continue
    }
    if ("opened" in kept) {
      const open = openings.at(-1)
      if (open && open.opened === undefined) open.opened = messages.length
      continue
    }
    if ("drawn" in kept) {
      drawn.push({ at: messages.length, update: kept.drawn, frame })
      continue
    }
    if ("closed" in kept) {
      closed ??= messages.length
      continue
    }
    const prompt: Prompt = { at: messages.length, frame }
    // What Mako showed, which the view drew; what the harness was sent where Mako kept no other words.
    const shown = kept.shown ?? kept.text
    if (shown !== undefined) prompt.text = shown
    if ("run" in kept && kept.run !== undefined) prompt.run = kept.run
    if ("attachments" in kept && kept.attachments?.length) prompt.attachments = kept.attachments
    if ("steered" in kept) prompt.steered = true
    if ("turn" in kept && kept.turn) prompt.turn = kept.turn
    if ("compaction" in kept && kept.compaction) prompt.compaction = true
    if ("shownAt" in kept && kept.shownAt !== undefined) {
      // Before the first message that arrived after Mako drew it, though no earlier than the turn before it.
      const shownAt = Date.parse(kept.shownAt)
      const floor = prompts.at(-1)?.at ?? 0
      let at = messages.length
      while (at > floor && times[at - 1]! > shownAt) at--
      if (at < messages.length) prompt.drawnAt = at
    }
    prompts.push(prompt)
  }
  if (!header.success) return { session: {}, messages }
  const recording: Recording = { harness: header.data.harness, native: { ...header.data.native, origin: "captured" }, session: header.data.session, messages, prompts, frames, times }
  if (openings.length) recording.openings = openings
  if (drawn.length) recording.drawn = drawn
  if (closed !== undefined) recording.closed = closed
  return recording
}

/** A Codex stream's read of its rollout, which names the bytes rather than copying them (`drawRollout`). */
const RolloutRangeSchema = z.object({ records: z.object({ rollout: z.string(), from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }) })

/** `message` with a rollout range read back into the records it stands for; any other message as it is. */
async function withRolloutRecords(message: JsonValue, rollouts: Map<string, Promise<Buffer>>): Promise<JsonValue> {
  const range = RolloutRangeSchema.safeParse(message)
  if (!range.success) return message
  const { rollout, from, to } = range.data.records
  let bytes = rollouts.get(rollout)
  if (!bytes) {
    bytes = readFile(rollout).catch(async () => zstdDecompressSync(await readFile(`${rollout}.zst`))).catch(() => {
      throw new Error(`The stream read ${rollout}, which is gone; restore the session from the record store (scripts/records.ts restore) to replay it`)
    })
    rollouts.set(rollout, bytes)
  }
  return { records: JsonSchema.parse(rolloutRecords((await bytes).subarray(from, to), from)) }
}

/** Fixture JSON with a stable key order, so `--update` diffs stay small. */
export function serializeFixture(fixture: Fixture): string {
  const { version, sdk, origin } = fixture.native
  const ordered = {
    harness: fixture.harness,
    source: fixture.source,
    native: sdk ? { version, sdk: { name: sdk.name, version: sdk.version }, origin } : { version, origin },
    about: fixture.about,
    session: fixture.session,
    steps: fixture.steps.map((step) => ({ message: step.message, decoded: step.decoded })),
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/** One decoded event on one line: its kind, then its payload, shortened. */
export function summarize(event: JsonValue, width = 140): string {
  const parsed = JsonObjectSchema.safeParse(event)
  if (!parsed.success) return clip(JSON.stringify(event), width)
  const { kind, ...rest } = parsed.data
  const payload = Object.keys(rest).length === 1 ? Object.values(rest)[0] : rest
  return `${String(kind).padEnd(10)} ${clip(JSON.stringify(payload) ?? "", width - 11)}`
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text
}

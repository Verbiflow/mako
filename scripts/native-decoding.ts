import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../electron/codex-app-json.ts"
import type { Decoded } from "../electron/contracts/native-decoding.ts"
import type { DecoderEffect, ProviderDecoderSource } from "../electron/providers/decoder-source.ts"
import { providerHost } from "../electron/providers/index.ts"

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

/** A key set to `undefined` (a state patch clearing it) has no JSON form; fixtures spell it out. */
export const UNSET = "(undefined)"

const JsonObjectSchema = z.record(z.string(), z.json())

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

/** A capture's first line, written by `electron/native-capture.ts`. */
const CaptureHeaderSchema = z.object({
  capture: z.number(),
  harness: z.string(),
  session: JsonObjectSchema,
  native: z.object({ version: VersionSchema, sdk: SdkSchema.optional() }).optional(),
})
const CaptureLineSchema = z.union([z.object({ message: z.json() }), z.object({ prompted: z.literal(true) })])

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
  const parsed = z.array(z.json()).safeParse(JSON.parse(JSON.stringify(events, (_key, value) => value === undefined ? UNSET : value)))
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
  /** Where Mako sent a prompt, as the index of the first message after it. */
  prompts?: number[]
}

/** Messages from a capture, a fixture, or a file of one native message per line. */
export async function readRecording(path: string): Promise<Recording> {
  const text = await readFile(path, "utf8")
  if (path.endsWith(".json")) {
    const fixture = FixtureSchema.parse(JSON.parse(text))
    return { harness: fixture.harness, native: fixture.native, session: fixture.session, messages: fixture.steps.map((step) => step.message) }
  }
  const lines = text.split("\n").filter((line) => line.trim())
  const header = CaptureHeaderSchema.safeParse(JSON.parse(lines[0] ?? "null"))
  const body = header.success ? lines.slice(1) : lines
  const messages: JsonValue[] = []
  const prompts: number[] = []
  for (const line of body) {
    const value = z.json().parse(JSON.parse(line))
    if (!header.success) {
      messages.push(value)
      continue
    }
    const captured = CaptureLineSchema.safeParse(value)
    if (!captured.success) continue
    if ("message" in captured.data) messages.push(captured.data.message)
    else prompts.push(messages.length)
  }
  return header.success
    ? { harness: header.data.harness, native: { ...header.data.native, origin: "captured" }, session: header.data.session, messages, prompts }
    : { session: {}, messages }
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

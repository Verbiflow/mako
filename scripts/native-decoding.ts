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
 * messages came from, what the driver knew before the first one (`session`),
 * and steps pairing each native message with the events it decodes to, in
 * order, so a review reads the message beside its meaning.
 */
export const FIXTURE_ROOT = join(import.meta.dirname, "fixtures", "native-decoding")

/** A key set to `undefined` (a state patch clearing it) has no JSON form; fixtures spell it out. */
export const UNSET = "(undefined)"

const JsonObjectSchema = z.record(z.string(), z.json())

export const FixtureSchema = z.object({
  harness: z.string(),
  source: z.string(),
  about: z.string(),
  session: JsonObjectSchema.default({}),
  steps: z.array(z.object({ message: z.json(), decoded: z.array(z.json()).optional() })).min(1),
})
export type Fixture = z.infer<typeof FixtureSchema>

/** A capture's first line, written by `electron/native-capture.ts`. */
const CaptureHeaderSchema = z.object({ capture: z.number(), harness: z.string(), session: JsonObjectSchema })
const CaptureLineSchema = z.object({ message: z.json() })

export function decoders(): ProviderDecoderSource[] {
  return providerHost.decoders.list()
}

export function decoderFor(harness: string): ProviderDecoderSource {
  const source = providerHost.decoders.get(harness)
  if (source) return source
  const absent = providerHost.harnesses.get(harness)?.absent.decoder
  const known = decoders().map((decoder) => decoder.provider).join(", ")
  throw new Error(absent
    ? `${harness} has no decoder yet: ${absent.reason}. Decoders: ${known}`
    : `No harness named ${harness}. Decoders: ${known}`)
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

export async function loadFixtures(harness?: string): Promise<FixtureFile[]> {
  const harnesses = harness ? [harness] : await readdir(FIXTURE_ROOT).catch(() => [])
  const files: FixtureFile[] = []
  for (const name of harnesses.sort()) {
    const folder = join(FIXTURE_ROOT, name)
    const entries = await readdir(folder).catch(() => [])
    for (const entry of entries.filter((file) => file.endsWith(".json")).sort()) {
      const path = join(folder, entry)
      const parsed = FixtureSchema.safeParse(JSON.parse(await readFile(path, "utf8")))
      if (!parsed.success) throw new Error(`${path} is not a decoding fixture: ${z.prettifyError(parsed.error)}`)
      files.push({ path, name: `${name}/${entry.slice(0, -".json".length)}`, fixture: parsed.data })
    }
  }
  return files
}

/** Messages from a capture, a fixture, or a file of one native message per line. */
export async function readRecording(path: string): Promise<{ harness?: string; session: JsonObject; messages: JsonValue[] }> {
  const text = await readFile(path, "utf8")
  if (path.endsWith(".json")) {
    const fixture = FixtureSchema.parse(JSON.parse(text))
    return { harness: fixture.harness, session: fixture.session, messages: fixture.steps.map((step) => step.message) }
  }
  const lines = text.split("\n").filter((line) => line.trim())
  const header = CaptureHeaderSchema.safeParse(JSON.parse(lines[0] ?? "null"))
  const body = header.success ? lines.slice(1) : lines
  const messages: JsonValue[] = []
  for (const line of body) {
    const value = z.json().parse(JSON.parse(line))
    if (!header.success) {
      messages.push(value)
      continue
    }
    const captured = CaptureLineSchema.safeParse(value)
    if (captured.success) messages.push(captured.data.message)
  }
  return header.success
    ? { harness: header.data.harness, session: header.data.session, messages }
    : { session: {}, messages }
}

/** Fixture JSON with a stable key order, so `--update` diffs stay small. */
export function serializeFixture(fixture: Fixture): string {
  const ordered = {
    harness: fixture.harness,
    source: fixture.source,
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

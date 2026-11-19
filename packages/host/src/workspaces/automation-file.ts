import { mkdir, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { publishFile } from "../base/published-files.js"
import {
  AUTOMATIONS_FILE,
  AUTOMATIONS_FILE_VERSION,
  AutomationDefinitionSchema,
  AutomationTriggerSchema,
  AutomationsFileSchema,
  LegacyAutomationSchema,
  type AutomationDefinition,
  type AutomationTrigger,
} from "../contracts/automations.js"
import type { JsonObject, JsonValue } from "../contracts/json.js"

/**
 * The project's `.mako/automations.json`: read in either shape, written in the new one.
 *
 * A file from a repository is input, not configuration Mako wrote, so nothing in it switches anything on, and what this
 * build can't read is kept as it is: an entry it can't read stays in the file untouched (`skipped`), and a trigger it
 * doesn't know is kept word for word as `unsupported`.
 */

export interface AutomationFileReading {
  exists: boolean
  definitions: AutomationDefinition[]
  /** Read from the first shape. */
  legacy: boolean
  /** Why the file couldn't be read at all. */
  error?: string
  /** Entries this build couldn't read, as they were, written back with the rest. */
  kept: JsonValue[]
  /** What each kept entry lacked, in words. */
  skipped: string[]
  /** The file's modification time, to read again only once it changes. */
  mtimeMs?: number
}

const JsonSchema = z.json()
const JsonObjectSchema = z.record(z.string(), z.json())
const LegacyDocumentSchema = z.object({ automations: z.array(z.json()) })
/** A word where one is expected: a kind's, an id's, a legacy prompt's or trigger's. */
const TextSchema = z.string()
/** What tells the first shape apart: a plain prompt, or a `trigger`. */
const LegacyMarkSchema = z.union([z.object({ prompt: z.string() }).loose(), z.object({ trigger: z.json() }).loose()])
const KindSchema = z.object({ kind: z.string() }).loose()
const IdSchema = z.object({ id: z.string() }).loose()

export function automationsFile(project: string): string {
  return join(project, AUTOMATIONS_FILE)
}

/** The project's automations, or why there are none. */
export async function readAutomationFile(project: string): Promise<AutomationFileReading> {
  const path = automationsFile(project)
  let text: string
  let mtimeMs: number | undefined
  try {
    ;[text, mtimeMs] = await Promise.all([readFile(path, "utf8"), stat(path).then((info) => info.mtimeMs)])
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { exists: false, definitions: [], legacy: false, kept: [], skipped: [] }
    return { exists: true, definitions: [], legacy: false, kept: [], skipped: [], error: `Mako can't read ${AUTOMATIONS_FILE}: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { ...parseAutomationFile(text), exists: true, ...(mtimeMs !== undefined && { mtimeMs }) }
}

/** The file's text read as definitions; either shape. */
export function parseAutomationFile(text: string): Omit<AutomationFileReading, "exists"> {
  let value: JsonValue
  try {
    value = JsonSchema.parse(JSON.parse(text))
  } catch (error) {
    return { definitions: [], legacy: false, kept: [], skipped: [], error: `${AUTOMATIONS_FILE} isn't JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const current = AutomationsFileSchema.safeParse(value)
  const legacy = !current.success ? LegacyDocumentSchema.safeParse(value) : undefined
  if (!current.success && !legacy?.success) return { definitions: [], legacy: false, kept: [], skipped: [], error: `${AUTOMATIONS_FILE} has no automations list.` }
  const entries = current.success ? current.data.automations : legacy?.data?.automations ?? []
  const definitions: AutomationDefinition[] = []
  const kept: JsonValue[] = []
  const skipped: string[] = []
  const ids = new Set<string>()
  let sawLegacy = !current.success
  for (const entry of entries) {
    const object = JsonObjectSchema.safeParse(entry).data
    const isLegacy = object !== undefined && LegacyMarkSchema.safeParse(object).success
    sawLegacy ||= isLegacy
    const read = object ? (isLegacy ? fromLegacy(object) : readDefinition(object)) : { why: "an entry isn't an object" }
    if ("why" in read || ids.has(read.definition.id)) {
      kept.push(entry)
      skipped.push("why" in read ? read.why : `${read.definition.id} is named twice; the second is kept as it is`)
      continue
    }
    ids.add(read.definition.id)
    definitions.push(read.definition)
  }
  return { definitions, legacy: sawLegacy, kept, skipped }
}

/** One entry in the new shape; a trigger it can't read is kept as `unsupported`, so the rest still runs. */
function readDefinition(object: JsonObject): { definition: AutomationDefinition } | { why: string } {
  const triggers = Array.isArray(object.triggers) ? object.triggers.map(readTrigger) : undefined
  const parsed = AutomationDefinitionSchema.safeParse({ ...object, ...(triggers && { triggers }) })
  if (parsed.success) return { definition: parsed.data }
  const label = IdSchema.safeParse(object).data?.id ?? "an automation"
  return { why: `${label}: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "entry"} ${issue.message}`).join("; ")}` }
}

function readTrigger(raw: JsonValue): AutomationTrigger {
  const parsed = AutomationTriggerSchema.safeParse(raw)
  if (parsed.success && parsed.data.kind !== "unsupported") return parsed.data
  // Kept as it was written, even one that says it's unsupported, so a newer build reads it again.
  if (parsed.success) return parsed.data
  const kind = KindSchema.safeParse(raw).data?.kind
  return { kind: "unsupported", raw, why: kind !== undefined ? `this Mako doesn't fire "${kind}" triggers in this form` : "it names no kind this Mako knows" }
}

/** Ids from the first shape: whatever was there, lowercased to what an id is now. */
function legacyId(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 80)
  return cleaned || fallback
}

/**
 * The first shape: `trigger` becomes `triggers[0]`, with default start settings. `files` (an agent in the person's
 * checkout on every save) and the Slack, Gmail and Calendar stubs, which could never fire, are kept as `unsupported`.
 */
export function fromLegacy(object: JsonObject): { definition: AutomationDefinition } | { why: string } {
  const legacy = LegacyAutomationSchema.safeParse(object)
  if (!legacy.success || !legacy.data.prompt?.trim()) return { why: `${IdSchema.safeParse(object).data?.id ?? "an automation"} has no prompt` }
  const { id, name, prompt, trigger } = legacy.data
  const named = TextSchema.safeParse(trigger).data
  const kind = named ?? KindSchema.safeParse(trigger).data?.kind
  const triggers: AutomationTrigger[] =
    kind === "commit" ? [{ kind: "commit" }]
    : kind === "manual" || kind === undefined ? [{ kind: "manual" }]
    : kind === "files" ? [{ kind: "unsupported", raw: named !== undefined ? { kind: "files", paths: object.paths ?? [] } : trigger ?? null, why: "file-change triggers are gone: they ran an agent in your checkout on every save" }]
    : [{ kind: "unsupported", raw: trigger ?? null, why: `"${String(kind)}" triggers arrive with the cloud account's receivers` }]
  const parsed = AutomationDefinitionSchema.safeParse({
    id: legacyId(id, `automation-${Math.abs(hash(prompt!)).toString(36)}`),
    name: name?.trim().slice(0, 120) || "Untitled",
    prompt: { objective: prompt!.trim() },
    triggers,
  })
  return parsed.success ? { definition: parsed.data } : { why: parsed.error.issues[0]?.message ?? "it can't be read" }
}

function hash(text: string): number {
  let value = 0
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) | 0
  return value
}

/** Writes the new shape, with what this build couldn't read kept after the rest. */
export async function writeAutomationFile(project: string, definitions: readonly AutomationDefinition[], kept: readonly JsonValue[]): Promise<void> {
  const path = automationsFile(project)
  await mkdir(dirname(path), { recursive: true })
  const document = { version: AUTOMATIONS_FILE_VERSION, automations: [...definitions.map(writtenDefinition), ...kept] }
  await publishFile(path, `${JSON.stringify(document, null, 2)}\n`)
}

/** A definition as the file keeps it: an unsupported trigger goes back as it was written. */
function writtenDefinition(definition: AutomationDefinition): JsonValue {
  const triggers = definition.triggers.map((trigger) => (trigger.kind === "unsupported" ? trigger.raw : JsonSchema.parse(trigger)))
  return JsonSchema.parse(JSON.parse(JSON.stringify({ ...definition, triggers })))
}

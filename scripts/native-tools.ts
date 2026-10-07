import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

/**
 * Each harness's tools as it defines them to its model, one file per harness
 * version: `npm run harness:native-tools -- <harness>` writes them, and
 * `scripts/test-native-tools.ts` checks the vocabularies against the
 * newest.
 */
export const NATIVE_TOOLS_DIR = join(import.meta.dirname, "fixtures", "native-tools")

/** Harnesses with no recorded definitions, and why. */
export const NO_SOURCE = new Map([
  ["devin", "Its requests are protobuf to the Windsurf API, and it sends none to its model until GetUserStatus and GetCliModelConfigs are answered, so a capture would have to answer them in Windsurf's own messages."],
])

const Parameter = z.object({ type: z.string(), required: z.boolean() })
export type Parameter = z.infer<typeof Parameter>
const Parameters = z.record(z.string(), Parameter)
type Parameters = z.infer<typeof Parameters>
const DefinedTool = z.object({
  namespace: z.string().optional(),
  /** `function` takes JSON arguments, `freeform` raw text in a grammar, `hosted` runs on the model provider's side. */
  form: z.enum(["function", "freeform", "hosted"]),
  /** Paths of the throwaway home and project are replaced before hashing, so only the harness's own wording counts. Absent from a source without wording. */
  description: z.object({ chars: z.number(), sha: z.string() }).optional(),
  parameters: Parameters.optional(),
  /** Named to the model without its schema, which loads through the harness's tool search. */
  deferred: z.literal(true).optional(),
  /** Called from inside this tool's script, as Codex's code mode calls its tools from `exec`, not by the model directly. */
  within: z.string().optional(),
  /** Keeps deferred loading switched on; never a tool the model calls. */
  placeholder: z.literal(true).optional(),
})
export type DefinedTool = z.infer<typeof DefinedTool>

const DefinedTools = z.record(z.string(), DefinedTool)
/** A configuration's tools, by the name the model calls. */
export type DefinedTools = z.infer<typeof DefinedTools>

const Configuration = z.object({ name: z.string(), tools: DefinedTools })
export type Configuration = z.infer<typeof Configuration>

export const NativeDefinitions = z.object({
  harness: z.string(),
  version: z.string(),
  on: z.string(),
  source: z.string(),
  configurations: z.array(Configuration).min(1),
})
export type NativeDefinitions = z.infer<typeof NativeDefinitions>

/** How the tools were written on the wire. */
export type Wire = "anthropic" | "responses" | "chat"

type Scrub = (text: string) => string

/** As much of a property's JSON Schema as names its type. */
const PropertySchema = z.looseObject({
  type: z.union([z.string().transform((type) => [type]), z.array(z.string())]).optional(),
  get anyOf() { return z.array(PropertySchema).optional() },
  get oneOf() { return z.array(PropertySchema).optional() },
  enum: z.array(z.unknown()).optional(),
  const: z.unknown().optional(),
})
type PropertySchema = z.infer<typeof PropertySchema>

const ArgumentsSchema = z.object({
  properties: z.record(z.string(), PropertySchema).optional(),
  required: z.array(z.string()).optional(),
}).loose()
type ArgumentsSchema = z.infer<typeof ArgumentsSchema>

function typeName({ type, anyOf, oneOf, enum: values, const: constant }: PropertySchema): string {
  if (type) return values && type.length === 1 ? "enum" : type.join("|")
  const union = anyOf ?? oneOf
  if (union) return [...new Set(union.map(typeName))].join("|")
  if (values) return "enum"
  return constant === undefined ? "any" : "const"
}

function parameters(schema: ArgumentsSchema | undefined): Parameters {
  const required = new Set(schema?.required ?? [])
  return Object.fromEntries(Object.entries(schema?.properties ?? {}).map(([name, value]) => [name, { type: typeName(value), required: required.has(name) }]))
}

const describe = (text: string | undefined, scrub: Scrub) => {
  const wording = scrub(text ?? "")
  return { chars: wording.length, sha: createHash("sha256").update(wording).digest("hex").slice(0, 12) }
}

const AnthropicTool = z.object({ name: z.string(), type: z.string().optional(), description: z.string().optional(), input_schema: ArgumentsSchema.optional(), defer_loading: z.boolean().optional() }).loose()
const ChatTool = z.object({ type: z.literal("function"), function: z.object({ name: z.string(), description: z.string().optional(), parameters: ArgumentsSchema.optional() }) })
const ResponsesTool = z.object({
  type: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  parameters: ArgumentsSchema.optional(),
  tools: z.array(z.unknown()).optional(),
}).loose()

const NESTED_TOOL = /### `(\w+)`\n([\s\S]*?)\n+exec tool declaration:\n```ts\ndeclare const tools: \{ \1\((?:input: string|args: \{([\s\S]*?)\n?\})\): Promise</g

/** A TypeScript field type, named as the JSON Schema types are. */
function scriptType(type: string): string {
  if (type.startsWith("Array<")) return "array"
  if (type.startsWith("{")) return "object"
  if (/^"[^"]*"( \| "[^"]*")*$/.test(type)) return "enum"
  return ["string", "number", "boolean"].includes(type) ? type : "any"
}

/** The top-level fields of a declaration's `args: { … }`, by brace depth; comments name nothing. */
function scriptParameters(body: string): Parameters {
  const out: Parameters = {}
  let depth = 0
  for (const line of body.split("\n")) {
    const field = depth === 0 ? /^\s*(\w+)(\?)?: (.*?);?$/.exec(line) : null
    if (field) out[field[1]!] = { type: scriptType(field[3]!), required: !field[2] }
    if (!line.trim().startsWith("//")) depth += (line.match(/[{<]/g)?.length ?? 0) - (line.match(/[}>]/g)?.length ?? 0)
  }
  return out
}

/** The tools a code-mode script calls, from the declarations in its tool's description. */
function nestedTools(description: string, within: string, scrub: Scrub): [string, DefinedTool][] {
  const declared = description.split("declare const tools: {").length - 1
  const matches = [...description.matchAll(NESTED_TOOL)]
  if (matches.length !== declared) throw new Error(`${within} declares ${declared} nested tools, but only ${matches.length} read as a heading, prose and a declaration`)
  return matches.map(([, name, prose, body]) => [name!, body === undefined
    ? { within, form: "freeform", description: describe(prose, scrub) }
    : { within, form: "function", description: describe(prose, scrub), parameters: scriptParameters(body) }])
}

/** One harness configuration's tools from its model request, by the name the model calls. */
export function definedTools(wire: Wire, tools: readonly unknown[], scrub: Scrub): DefinedTools {
  const out: DefinedTools = {}
  const add = (name: string, tool: DefinedTool) => {
    const key = out[name] && tool.namespace ? `${tool.namespace}.${name}` : name
    if (out[key]) throw new Error(`Two tools are both named ${key}`)
    out[key] = tool
  }
  const responses = (items: readonly unknown[], namespace?: string) => {
    for (const item of items) {
      const tool = ResponsesTool.parse(item)
      const base = namespace ? { namespace } : {}
      if (tool.type === "namespace") responses(tool.tools ?? [], tool.name)
      else if (tool.type === "function" && tool.name) add(tool.name, { ...base, form: "function", description: describe(tool.description, scrub), parameters: parameters(tool.parameters) })
      else if (tool.type === "custom" && tool.name) {
        add(tool.name, { ...base, form: "freeform", description: describe(tool.description, scrub) })
        for (const [name, nested] of nestedTools(tool.description ?? "", tool.name, scrub)) add(name, nested)
      }
      else add(tool.name ?? tool.type, { ...base, form: "hosted", description: describe(tool.description, scrub) })
    }
  }
  if (wire === "responses") responses(tools)
  for (const item of wire === "anthropic" ? tools : []) {
    const tool = AnthropicTool.parse(item)
    if (tool.input_schema === undefined) {
      add(tool.name, { form: "hosted", description: describe(tool.description, scrub) })
      continue
    }
    const defined: DefinedTool = { form: "function", description: describe(tool.description, scrub), parameters: parameters(tool.input_schema) }
    if (tool.defer_loading) defined.placeholder = true
    add(tool.name, defined)
  }
  for (const item of wire === "chat" ? tools : []) {
    const { function: tool } = ChatTool.parse(item)
    add(tool.name, { form: "function", description: describe(tool.description, scrub), parameters: parameters(tool.parameters) })
  }
  return out
}

/** `1.2.10` after `1.2.9`. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(/[.-]/).map(Number)
  const b = right.split(/[.-]/).map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

export const definitionsPath = (harness: string, version: string) => join(NATIVE_TOOLS_DIR, `${harness}-${version}.json`)

/** Every stored version of a harness's definitions, oldest first. */
export function storedDefinitions(harness: string): NativeDefinitions[] {
  if (!existsSync(NATIVE_TOOLS_DIR)) return []
  return readdirSync(NATIVE_TOOLS_DIR)
    .filter((file) => file.startsWith(`${harness}-`) && file.endsWith(".json"))
    .map((file) => NativeDefinitions.parse(JSON.parse(readFileSync(join(NATIVE_TOOLS_DIR, file), "utf8"))))
    .filter((definitions) => definitions.harness === harness)
    .sort((a, b) => compareVersions(a.version, b.version))
}

/** Each tool once, with the configurations that define it; a tool defined differently in two keeps the first. */
export function toolsAcross(definitions: NativeDefinitions): Map<string, { tool: DefinedTool; in: string[] }> {
  const tools = new Map<string, { tool: DefinedTool; in: string[] }>()
  for (const configuration of definitions.configurations)
    for (const [name, tool] of Object.entries(configuration.tools)) {
      const seen = tools.get(name)
      if (seen) seen.in.push(configuration.name)
      else tools.set(name, { tool, in: [configuration.name] })
    }
  return tools
}

function toolChanges(name: string, before: DefinedTool, after: DefinedTool): string[] {
  const lines: string[] = []
  if (before.form !== after.form) lines.push(`~ ${name}: ${before.form} → ${after.form}`)
  if (before.deferred !== after.deferred) lines.push(`~ ${name}: ${after.deferred ? "now deferred" : "now loaded whole"}`)
  if (before.within !== after.within) lines.push(`~ ${name}: ${after.within ? `now called from ${after.within}` : "now called by the model"}`)
  if (before.namespace !== after.namespace) lines.push(`~ ${name}: namespace ${before.namespace ?? "none"} → ${after.namespace ?? "none"}`)
  if (before.description && after.description && before.description.sha !== after.description.sha)
    lines.push(`~ ${name}: description reworded (${before.description.chars} → ${after.description.chars} characters)`)
  const was = before.parameters ?? {}
  const now = after.parameters ?? {}
  for (const parameter of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const [old, next] = [was[parameter], now[parameter]]
    if (!old) lines.push(`+ ${name}.${parameter}: ${next!.type}${next!.required ? ", required" : ""}`)
    else if (!next) lines.push(`- ${name}.${parameter}`)
    else {
      if (old.type !== next.type) lines.push(`~ ${name}.${parameter}: ${old.type} → ${next.type}`)
      if (old.required !== next.required) lines.push(`~ ${name}.${parameter}: ${next.required ? "now required" : "now optional"}`)
    }
  }
  return lines
}

/** What changed from one version's definitions to another's, per configuration. */
export function diffDefinitions(before: NativeDefinitions, after: NativeDefinitions): string[] {
  const lines: string[] = []
  const old = new Map(before.configurations.map((configuration) => [configuration.name, configuration.tools]))
  const next = new Map(after.configurations.map((configuration) => [configuration.name, configuration.tools]))
  for (const name of new Set([...old.keys(), ...next.keys()])) {
    const [was, now] = [old.get(name), next.get(name)]
    if (!was || !now) {
      lines.push(`${was ? "-" : "+"} configuration ${name}`)
      continue
    }
    const changes: string[] = []
    for (const tool of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (!was[tool]) changes.push(`+ ${tool}`)
      else if (!now[tool]) changes.push(`- ${tool}`)
      else changes.push(...toolChanges(tool, was[tool]!, now[tool]!))
    }
    if (changes.length) lines.push(`${name}:`, ...changes.map((change) => `  ${change}`))
  }
  return lines
}

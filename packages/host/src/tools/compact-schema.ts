import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

/** A JSON Schema as a tools/list sends it: JSON, read as such (`z.json()`). */
export type JsonSchema = z.core.util.JSONType

const SchemaObject = z.record(z.string(), z.json())
/** One literal of a union as zod writes it: `{type, const}`. */
const Literal = z.strictObject({ const: z.union([z.string(), z.number(), z.boolean()]), type: z.string().optional() })
const Literals = z.array(Literal).min(2)
const EmptyObject = z.strictObject({})

/**
 * A tool's input schema as an agent's context pays for it, said in fewer tokens and meaning the same: no `$schema`
 * (no harness reads it; 697 tokens over the `mako` server), a union of literals as one `enum` (zod writes each as
 * `{type, const}` in an `anyOf`; 840 tokens), and no `additionalProperties: {}`, which allows what leaving it out
 * allows. Plain JSON Schema that Claude Code, Codex, Cursor, Grok, OpenCode and Devin all take.
 */
export function compactSchema(schema: JsonSchema, root = true): JsonSchema {
  if (Array.isArray(schema)) return schema.map((each) => compactSchema(each, false))
  const object = SchemaObject.safeParse(schema)
  if (!object.success) return schema
  const compact: Record<string, JsonSchema> = {}
  for (const [key, value] of Object.entries(object.data)) {
    if (root && key === "$schema") continue
    if (key === "additionalProperties" && EmptyObject.safeParse(value).success) continue
    const literals = key === "anyOf" ? literalUnion(value) : undefined
    if (literals) {
      if (literals.type !== undefined) compact.type = literals.type
      compact.enum = literals.values
      continue
    }
    compact[key] = compactSchema(value, false)
  }
  return compact
}

/** An `anyOf` whose branches are each one literal of the same type (or none named), as that type and its values. */
function literalUnion(anyOf: JsonSchema): { type?: string; values: JsonSchema[] } | undefined {
  const branches = Literals.safeParse(anyOf)
  if (!branches.success) return undefined
  const types = new Set(branches.data.map((branch) => branch.type))
  if (types.size !== 1) return undefined
  const [type] = types
  return { ...(type !== undefined && { type }), values: branches.data.map((branch) => branch.const) }
}

/** A tools/list result, each tool's input schema read as JSON; the rest of each tool passes through as it is. */
const ListedTools = z.looseObject({ tools: z.array(z.looseObject({ inputSchema: z.json() })) })

/**
 * Lists `server`'s tools with compact input schemas (`compactSchema`). Call before registering any tool: the server
 * installs its tools/list handler with its first tool, and that handler is the one wrapped here, so a listing is the
 * SDK's own with each schema compacted. Calls are still validated against the registered schemas.
 */
export function compactToolLists(server: McpServer): McpServer {
  const inner = server.server
  const set = inner.setRequestHandler.bind(inner)
  inner.setRequestHandler = (schema, handler) =>
    set(schema, async (request, extra) => {
      const result = await handler(request, extra)
      const listed = request.method === "tools/list" ? ListedTools.safeParse(result) : undefined
      if (!listed?.success) return result
      return Object.assign(result, { tools: listed.data.tools.map((tool) => ({ ...tool, inputSchema: compactSchema(tool.inputSchema) })) })
    })
  return server
}

import { z } from "zod"
import type { JsonValue } from "../json.js"

const jsonObject = z.record(z.string(), z.json())

/**
 * Rust schema generators tag integers and floats with formats such as
 * `uint32` and `double`. Those are not JSON Schema formats, so every MCP
 * client that compiles the driver's schemas logs "unknown format ignored" for
 * each one. The driver owns those schemas; Mako rewrites the formats into
 * numeric ranges before compiling them itself and before republishing them,
 * so validation stays strict and provider logs stay clean.
 */
const RANGES = new Map<string, { minimum: number; maximum: number } | null>([
  ["int8", { minimum: -128, maximum: 127 }],
  ["int16", { minimum: -32_768, maximum: 32_767 }],
  ["int32", { minimum: -2_147_483_648, maximum: 2_147_483_647 }],
  ["int64", null],
  ["uint8", { minimum: 0, maximum: 255 }],
  ["uint16", { minimum: 0, maximum: 65_535 }],
  ["uint32", { minimum: 0, maximum: 4_294_967_295 }],
  ["uint64", { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }],
  ["float", null],
  ["double", null],
])

export function normalizeDriverSchema(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalizeDriverSchema)
  const object = jsonObject.safeParse(value)
  if (!object.success) return value
  const next = Object.fromEntries(
    Object.entries(object.data).map(([key, entry]) => [
      key,
      normalizeDriverSchema(entry),
    ])
  )
  const format = z.string().safeParse(next.format)
  const range = format.success ? RANGES.get(format.data) : undefined
  if (range !== undefined) {
    delete next.format
    if (range) {
      next.minimum ??= range.minimum
      next.maximum ??= range.maximum
    }
  }
  return next
}

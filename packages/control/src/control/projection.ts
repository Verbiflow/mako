import { z } from "zod"
import type { JsonValue } from "../json.js"

const PageNodeSchema = z.looseObject({
  ref: z.string().optional(),
  depth: z.number().int().nonnegative().optional(),
  role: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
  disabled: z.union([z.string(), z.boolean()]).optional(),
  selected: z.union([z.string(), z.boolean()]).optional(),
  focused: z.union([z.string(), z.boolean()]).optional(),
  expanded: z.union([z.string(), z.boolean()]).optional(),
})

const VALUE_LENGTH = 80

function active(value: string | boolean | undefined): boolean {
  return value === true || value === "true"
}

/** One browser accessibility node in the same compact shape as a native view line. */
export function pageElementLine(raw: JsonValue): string | undefined {
  const parsed = PageNodeSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const node = parsed.data
  const parts: string[] = []
  if (node.ref) parts.push(node.ref)
  parts.push(node.role || "Node")
  if (node.name) parts.push(JSON.stringify(node.name))
  if (node.value !== undefined && node.value !== null) {
    const text = String(node.value)
    if (text !== node.name && text !== "")
      parts.push(
        `=${JSON.stringify(text.length > VALUE_LENGTH ? `${text.slice(0, VALUE_LENGTH)}…` : text)}`
      )
  }
  if (active(node.disabled)) parts.push("disabled")
  if (active(node.selected)) parts.push("selected")
  if (active(node.focused)) parts.push("focused")
  if (active(node.expanded)) parts.push("expanded")
  return parts.join(" ")
}

export function pageElementLines(nodes: readonly JsonValue[]): string[] {
  return nodes.flatMap((node) => {
    const line = pageElementLine(node)
    return line ? [line] : []
  })
}

/**
 * Extracts the opaque address from either a CUA line (`s…:n`) or a browser
 * observation line (`hex:n`). The backend still validates its generation.
 */
export function controlLineRef(line: string): string {
  const ref = /^([A-Za-z0-9_-]+:\d+)(?: |$)/.exec(line)?.[1]
  if (!ref)
    throw new Error(
      "This line has no control ref. Use a line from the newest observation."
    )
  return ref
}

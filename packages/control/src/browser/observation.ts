import { z } from "zod"
import type { JsonValue } from "../json.js"

const pageNodeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
])

export const PageObservationNodeSchema = z
  .object({
    ref: z.string().optional(),
    depth: z.number().int().nonnegative(),
    role: z.string().nullable(),
    name: z.string().optional(),
    value: z.string().optional(),
    /** A control's shown label, present only when it differs from `name`. */
    visibleText: z.string().optional(),
  })
  .catchall(pageNodeValueSchema)
export type PageObservationNode = z.infer<typeof PageObservationNodeSchema>

export const PageObservationSchema = z
  .object({
    nodes: z.array(PageObservationNodeSchema),
  })
  .catchall(z.json())
export type PageObservation = z.infer<typeof PageObservationSchema>

export const PageNodeSelectorSchema = z
  .object({
    role: z.string().min(1).max(100).optional(),
    name: z.string().max(500).optional(),
    text: z.string().max(500).optional(),
    roles: z.array(z.string().min(1).max(100)).max(64).optional(),
    states: z
      .record(z.string().min(1).max(100), pageNodeValueSchema)
      .optional(),
    refsOnly: z.boolean().default(false),
    includeAncestors: z.boolean().default(true),
    max: z.number().int().min(1).max(1000).default(100),
  })
  .strict()
export type PageNodeSelector = z.input<typeof PageNodeSelectorSchema>
type ParsedPageNodeSelector = z.output<typeof PageNodeSelectorSchema>

export interface PageNodeSelection {
  nodes: PageObservationNode[]
  matched: number
  returned: number
  context: number
  omitted: number
}

function nodeText(node: PageObservationNode): string {
  return [node.role ?? "", node.name ?? "", node.value ?? "", node.visibleText ?? ""]
    .join("\n")
    .toLocaleLowerCase()
}

function hasStates(
  node: PageObservationNode,
  states: Readonly<Record<string, JsonValue>> | undefined
): boolean {
  if (!states) return true
  return Object.entries(states).every(
    ([name, value]) => node[name] === value
  )
}

function matches(node: PageObservationNode, selector: ParsedPageNodeSelector) {
  if (selector.role !== undefined && node.role !== selector.role) return false
  if (selector.name !== undefined && (node.name ?? "") !== selector.name) return false
  if (selector.refsOnly && node.ref === undefined) return false
  if (
    selector.roles &&
    !selector.roles.some(
      (role) => role.toLocaleLowerCase() === node.role?.toLocaleLowerCase()
    )
  )
    return false
  if (
    selector.text &&
    !nodeText(node).includes(selector.text.toLocaleLowerCase())
  )
    return false
  return hasStates(node, selector.states)
}

/**
 * Select a bounded semantic working set from a browser observation inside the
 * control worker. The complete observation never needs to enter model context.
 */
export function selectPageNodes(
  rawObservation: PageObservation,
  rawSelector: PageNodeSelector
): PageNodeSelection {
  const observation = PageObservationSchema.parse(rawObservation)
  const selector = PageNodeSelectorSchema.parse(rawSelector)
  const direct = observation.nodes
    .map((node, index) => ({ index, node }))
    .filter(({ node }) => matches(node, selector))
  const directIndexes = new Set(direct.map(({ index }) => index))
  const chosen = new Set<number>()
  const ancestors: Array<{ index: number; depth: number }> = []
  let directReturned = 0

  for (const { node, index } of observation.nodes.map((entry, entryIndex) => ({
    node: entry,
    index: entryIndex,
  }))) {
    while (
      ancestors.length > 0 &&
      ancestors[ancestors.length - 1]!.depth >= node.depth
    )
      ancestors.pop()

    if (directIndexes.has(index) && chosen.size < selector.max) {
      if (selector.includeAncestors) {
        const available = selector.max - chosen.size - 1
        if (available > 0)
          for (const ancestor of ancestors.slice(-available))
            chosen.add(ancestor.index)
      }
      if (chosen.size < selector.max) {
        chosen.add(index)
        directReturned++
      }
    }
    ancestors.push({ index, depth: node.depth })
  }

  const nodes = [...chosen]
    .sort((left, right) => left - right)
    .map((index) => observation.nodes[index]!)
  return {
    nodes,
    matched: direct.length,
    returned: nodes.length,
    context: nodes.length - directReturned,
    omitted: direct.length - directReturned,
  }
}

const quoted = (text: string, limit: number) =>
  JSON.stringify(text.length > limit ? `${text.slice(0, limit)}…` : text)
/** States worth reading when false as well: a collapsed menu, an unchecked box. */
const TWO_WAY_STATES = ["checked", "expanded", "pressed"] as const
const SET_STATES = ["selected", "focused", "disabled", "required", "readonly", "invalid", "modal"] as const

/** One outline row: ref, role, name, then only the facts that distinguish it.
 * Every field also stays on the node for programs. */
export function pageOutlineLine(node: PageObservationNode, indent = 0): string {
  const parts = [node.ref, node.role ?? "node"]
  if (node.name) parts.push(JSON.stringify(node.name))
  if (node.visibleText) parts.push(`visibleText=${JSON.stringify(node.visibleText)}`)
  if (node.value !== undefined && node.value !== "" && node.value !== node.name)
    parts.push(`value=${quoted(node.value, 80)}`)
  if (node.role === "link" && !node.name && typeof node.url === "string")
    parts.push(`url=${quoted(node.url, 120)}`)
  if (node.role === "heading" && typeof node.level === "number") parts.push(`level=${node.level}`)
  for (const state of TWO_WAY_STATES) {
    const value = node[state]
    if (value === true || value === "true") parts.push(state)
    else if (value === false || value === "false" || value === "mixed") parts.push(`${state}=${String(value)}`)
  }
  for (const state of SET_STATES)
    if (node[state] === true || node[state] === "true") parts.push(state)
  const popup = node.hasPopup
  if (typeof popup === "string" && popup !== "false") parts.push(`hasPopup=${popup}`)
  return "  ".repeat(indent) + parts.filter((part) => part !== undefined).join(" ")
}

/** The page as an indented outline, or a flat list for filtered reads, whose
 * rows are not one tree. Indentation starts at the shallowest row. */
export function pageOutlineLines(nodes: readonly PageObservationNode[], options: { flat?: boolean } = {}): string[] {
  const base = Math.min(...nodes.map((node) => node.depth))
  return nodes.map((node) => pageOutlineLine(node, options.flat ? 0 : Math.min(node.depth - base, 24)))
}

/** A selected working set with every field of each row, indented as an outline. */
export function pageNodeLines(nodes: readonly PageObservationNode[]): string[] {
  const base = Math.min(...nodes.map((node) => node.depth))
  return nodes.map((node) => {
    const fields = [
      node.ref,
      node.role ?? "node",
      node.name ? JSON.stringify(node.name) : undefined,
      node.value ? `value=${JSON.stringify(node.value)}` : undefined,
      node.visibleText ? `visibleText=${JSON.stringify(node.visibleText)}` : undefined,
      ...Object.entries(node)
        .filter(
          ([name, value]) =>
            !["ref", "depth", "role", "name", "value", "visibleText"].includes(name) &&
            value !== false &&
            value !== null &&
            value !== ""
        )
        .map(([name, value]) => `${name}=${String(value)}`),
    ]
    return "  ".repeat(Math.min(node.depth - base, 24)) + fields.filter((field) => field !== undefined).join(" ")
  })
}

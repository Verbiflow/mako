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
  return [node.role ?? "", node.name ?? "", node.value ?? ""]
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

/** Compact text for a selected working set; refs remain the first token. */
export function pageNodeLines(nodes: readonly PageObservationNode[]): string[] {
  return nodes.map((node) => {
    const fields = [
      node.ref,
      `${"  ".repeat(Math.min(node.depth, 20))}${node.role ?? "node"}`,
      node.name ? JSON.stringify(node.name) : undefined,
      node.value ? `value=${JSON.stringify(node.value)}` : undefined,
      ...Object.entries(node)
        .filter(
          ([name, value]) =>
            !["ref", "depth", "role", "name", "value"].includes(name) &&
            value !== false &&
            value !== null &&
            value !== ""
        )
        .map(([name, value]) => `${name}=${String(value)}`),
    ]
    return fields.filter((field) => field !== undefined).join(" ")
  })
}

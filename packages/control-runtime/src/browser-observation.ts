import { randomBytes } from "node:crypto"
import { z } from "zod"
import type { BrowserTarget } from "./contracts/browser-control.js"
import type { JsonObject, JsonValue } from "./json.js"

const accessibilityText = z
  .union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.json()).transform((value) => JSON.stringify(value)),
    z.record(z.string(), z.json()).transform((value) => JSON.stringify(value)),
  ])
  .transform((value) => String(value))
  .nullish()

export const AccessibilityNodeSchema = z.object({
  nodeId: z.string(),
  parentId: z.string().optional(),
  ignored: z.boolean(),
  backendDOMNodeId: z.number().optional(),
  role: z.object({ value: accessibilityText }).optional(),
  name: z.object({ value: accessibilityText }).optional(),
  value: z.object({ value: accessibilityText }).optional(),
  properties: z
    .array(
      z.object({
        name: z.string(),
        value: z.object({ value: accessibilityText }),
      })
    )
    .optional(),
})
type AccessibilityNode = z.infer<typeof AccessibilityNodeSchema>

/** Filter a fresh synchronous snapshot when background rendering is throttled. */
export function scopeAccessibilityNodes(
  nodes: AccessibilityNode[],
  scope: {
    within: Array<{ role: string; name: string }>
    match?: { role: string; name: string }
  }
): AccessibilityNode[] {
  let selected = nodes
  const children = new Map<string, AccessibilityNode[]>()
  for (const node of nodes)
    if (node.parentId) {
      const siblings = children.get(node.parentId) ?? []
      siblings.push(node)
      children.set(node.parentId, siblings)
    }
  for (const container of scope.within) {
    const matches = selected.filter(
      (node) =>
        !node.ignored &&
        node.role?.value === container.role &&
        (node.name?.value ?? "") === container.name
    )
    if (matches.length !== 1)
      throw new Error(
        `Scope requires one ${container.role} ${JSON.stringify(container.name)}; found ${matches.length}. Observe and disambiguate the container.`
      )
    const descendants = new Set<string>()
    const pending = [...(children.get(matches[0]!.nodeId) ?? [])]
    while (pending.length) {
      const node = pending.pop()!
      if (descendants.has(node.nodeId)) continue
      descendants.add(node.nodeId)
      pending.push(...(children.get(node.nodeId) ?? []))
    }
    selected = selected.filter((node) => descendants.has(node.nodeId))
  }
  if (scope.match)
    selected = selected.filter(
      (node) =>
        !node.ignored &&
        node.role?.value === scope.match!.role &&
        (node.name?.value ?? "") === scope.match!.name
    )
  return selected
}
const ObservationInfoSchema = z.object({
  targetInfo: z.object({
    targetId: z.string(),
    type: z.string(),
    title: z.string(),
    url: z.string(),
  }),
})
export interface ObservationViewport {
  pageX: number
  pageY: number
  clientWidth: number
  clientHeight: number
  contentWidth: number
  contentHeight: number
}

/** Roles an agent acts on. Anything focusable counts as well. */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "slider",
  "spinbutton",
  "switch",
  "treeitem",
  "menubutton",
  "togglebutton",
  "DisclosureTriangle",
  "PopUpButton",
  "ColorWell",
  "DateTime",
])
/** Text runs and breaks duplicate their parent StaticText. */
const SKIPPED_ROLES = new Set(["InlineTextBox", "LineBreak"])
/** Unnamed wrappers carry no information an agent can use. */
const WRAPPER_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "GenericContainer",
])
/** Accessibility states retain false and empty values as assertion evidence. */
const STATE_PROPERTIES = [
  "checked",
  "disabled",
  "focused",
  "expanded",
  "selected",
  "required",
  "pressed",
  "readonly",
  "invalid",
  "hasPopup",
  "level",
  "modal",
  "multiselectable",
  "url",
] as const

export const OBSERVATION_BUDGET_BYTES = 60_000

function propertyMap(node: AccessibilityNode): Map<string, string> {
  return new Map(
    (node.properties ?? []).flatMap((property) =>
      property.value.value === undefined || property.value.value === null
        ? []
        : [[property.name, property.value.value]]
    )
  )
}

/** Controls whose visible label can differ from their accessible name; text
 * entry is excluded because its visible text is its value or placeholder. */
const LABELLED_ROLES = new Set([...INTERACTIVE_ROLES].filter((role) =>
  !["textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton", "ColorWell", "DateTime"].includes(role)))

/** The document root is focusable but is never something to act on. */
const DOCUMENT_ROLES = new Set(["RootWebArea", "WebArea", "document"])
function isInteractive(role: string | null, properties: Map<string, string>) {
  if (role !== null && DOCUMENT_ROLES.has(role)) return false
  return (
    (role !== null && INTERACTIVE_ROLES.has(role)) ||
    properties.get("focusable") === "true"
  )
}

/** Bound the serialized result, not just node count: page-controlled names can
 * contain entire documents. Keep usable refs and explicitly report omissions. */
export function browserObservation(input: {
  target: BrowserTarget
  info: JsonValue
  nodes: AccessibilityNode[]
  maxNodes: number
  offset?: number
  query?: string
  exactValues?: boolean
  interactiveOnly?: boolean
  viewport?: ObservationViewport
}) {
  let truncatedTextFields = 0
  function text(
    value: string | null | undefined,
    limit: number
  ): string | null {
    if (value === undefined || value === null) return null
    const source = value
    if (source.length <= limit) return source
    truncatedTextFields++
    return source.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "") + "…"
  }
  const sourceInfo = ObservationInfoSchema.parse(input.info).targetInfo
  const info = {
    targetInfo: {
      ...sourceInfo,
      title: text(sourceInfo.title, 500),
      url: text(sourceInfo.url, 2048),
    },
  }
  const viewport = input.viewport
    ? {
        width: input.viewport.clientWidth,
        height: input.viewport.clientHeight,
        scrollX: input.viewport.pageX,
        scrollY: input.viewport.pageY,
        contentWidth: input.viewport.contentWidth,
        contentHeight: input.viewport.contentHeight,
        pagesAbove:
          Math.round(
            (input.viewport.pageY / input.viewport.clientHeight) * 10
          ) / 10,
        pagesBelow:
          Math.round(
            (Math.max(
              0,
              input.viewport.contentHeight -
                input.viewport.pageY -
                input.viewport.clientHeight
            ) /
              input.viewport.clientHeight) *
              10
          ) / 10,
      }
    : undefined
  const depths = new Map<string, number>()
  const query = input.query?.trim().toLowerCase() || undefined
  const candidates: Array<{ node: AccessibilityNode; row: JsonObject }> = []
  // CDP may return breadth-first rows. Emit depth-first rows so a container's
  // descendants remain together, including through ignored wrapper nodes.
  const byId = new Map(input.nodes.map((node) => [node.nodeId, node]))
  const children = new Map<string, AccessibilityNode[]>()
  const roots: AccessibilityNode[] = []
  for (const node of input.nodes) {
    if (node.parentId && byId.has(node.parentId)) {
      const siblings = children.get(node.parentId) ?? []
      siblings.push(node)
      children.set(node.parentId, siblings)
    } else roots.push(node)
  }
  // The label a person reads, from the control's own text descendants; nested
  // controls keep theirs. Differs from the accessible name only via ARIA/title.
  const visibleText = (control: AccessibilityNode) => {
    const parts: string[] = []
    const stack = [...(children.get(control.nodeId) ?? [])].reverse()
    for (let seen = 0; stack.length && seen < 200; seen++) {
      const node = stack.pop()!
      const role = node.role?.value ?? null
      if (!node.ignored && role === "StaticText" && node.name?.value) parts.push(node.name.value)
      if (!node.ignored && role !== null && LABELLED_ROLES.has(role)) continue
      stack.push(...[...(children.get(node.nodeId) ?? [])].reverse())
    }
    return parts.join(" ").replace(/\s+/g, " ").trim()
  }
  const pending = roots.reverse()
  const visited = new Set<string>()
  while (pending.length) {
    const node = pending.pop()!
    if (visited.has(node.nodeId)) continue
    visited.add(node.nodeId)
    const descendants = children.get(node.nodeId) ?? []
    for (let index = descendants.length - 1; index >= 0; index--)
      pending.push(descendants[index]!)
    const depth = node.parentId ? (depths.get(node.parentId) ?? 0) + 1 : 0
    depths.set(node.nodeId, depth)
    if (node.ignored) continue
    const role = node.role?.value ?? null
    if (role !== null && SKIPPED_ROLES.has(role)) continue
    const name = node.name?.value
    const value = node.value?.value
    const properties = propertyMap(node)
    if (
      role !== null &&
      WRAPPER_ROLES.has(role) &&
      !name &&
      !value &&
      !isInteractive(role, properties)
    )
      continue
    if (input.interactiveOnly && !isInteractive(role, properties)) continue
    const label = role !== null && LABELLED_ROLES.has(role) ? visibleText(node) : ""
    const shown = label && label !== (name ?? "").replace(/\s+/g, " ").trim() ? label : undefined
    if (
      query &&
      ![role ?? "", name ?? "", value ?? "", shown ?? ""].some((field) =>
        field.toLowerCase().includes(query)
      )
    )
      continue
    const row: JsonObject = { depth, role: text(role, 100) }
    const trimmedName = text(name, 500)
    if (trimmedName !== null && trimmedName !== "") row.name = trimmedName
    if (shown) row.visibleText = text(shown, 200)
    const trimmedValue = text(
      value,
      input.exactValues ? OBSERVATION_BUDGET_BYTES : 1000
    )
    if (trimmedValue !== null) row.value = trimmedValue
    for (const state of STATE_PROPERTIES) {
      const raw = properties.get(state)
      if (raw === undefined) continue
      if (state === "level") {
        const level = Number(raw)
        if (Number.isFinite(level)) row.level = level
        continue
      }
      row[state] = state === "url" ? (text(raw, 2048) ?? raw) : raw
    }
    candidates.push({ node, row })
  }
  const offset = Math.min(input.offset ?? 0, candidates.length)
  const prefix = randomBytes(3).toString("hex")
  const refs = new Map<string, number>()
  const nodes: JsonObject[] = []
  // Leave room for counters, separators and protocol metadata in the final JSON.
  let bytes =
    Buffer.byteLength(
      JSON.stringify({ target: input.target, info, viewport })
    ) + 320
  let index = offset
  for (; index < candidates.length && nodes.length < input.maxNodes; index++) {
    const { node, row } = candidates[index]
    const ref = node.backendDOMNodeId ? `${prefix}:${index}` : undefined
    const entry: JsonObject = ref ? { ref, ...row } : row
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1
    if (bytes + size > OBSERVATION_BUDGET_BYTES) break
    bytes += size
    nodes.push(entry)
    if (ref && node.backendDOMNodeId) refs.set(ref, node.backendDOMNodeId)
  }
  const nextOffset = index < candidates.length ? index : null
  return {
    refs,
    value: {
      target: { ...input.target },
      info,
      viewport: viewport ?? null,
      nodes,
      matched: candidates.length,
      offset,
      nextOffset,
      omitted: candidates.length - nodes.length - offset,
      truncatedTextFields,
    },
  }
}

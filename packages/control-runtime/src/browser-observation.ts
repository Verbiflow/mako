import { randomBytes } from "node:crypto"
import { PAGE_GROUPING_ROLES as GROUPING_ROLES } from "@mako/control/browser"
import { nameMatches, type NameMatch } from "@mako/control/control/scope"
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
  name: z
    .object({
      value: accessibilityText,
      sources: z
        .array(z.object({ type: z.string(), value: z.unknown().optional(), superseded: z.boolean().optional() }))
        .optional(),
    })
    .optional(),
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
    within: Array<{ role: string; name: NameMatch }>
    match?: { role: string; name: NameMatch }
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
        nameMatches(node.name?.value ?? "", container.name)
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
        nameMatches(node.name?.value ?? "", scope.match!.name)
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
/** Unnamed wrappers and inline formatting carry no information an agent can
 * use; their children take their place in the outline. */
const WRAPPER_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "GenericContainer",
  "group",
  "Section",
  "strong",
  "emphasis",
  "code",
  "time",
  "mark",
  "Abbr",
  "subscript",
  "superscript",
  "insertion",
  "deletion",
  "LabelText",
  "DescriptionListDetail",
  "DescriptionListTerm",
  "blockquote",
  "Pre",
  "figure",
])
/** Content roles whose name a named ancestor, such as a card's link, often
 * already contains. Landmarks, dialogs and controls always keep their row. */
const REPEATING_ROLES = new Set([
  "heading",
  "image",
  "img",
  "graphics-symbol",
  "generic",
  "group",
  "Figcaption",
  "LabelText",
  "time",
  "Abbr",
])
/** Chromium's roles for presentational tables. Their names concatenate their
 * cells' text, which the cells' own lines already show. */
const LAYOUT_ROLE = /^LayoutTable/
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

const spaced = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()
const unspaced = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, "")

/** Cells and rows Chromium names by concatenating their contents; their own
 * rows already show that text. */
const CONTENT_NAMED_ROLES = new Set(["cell", "gridcell", "row"])
function ownName(node: AccessibilityNode, role: string | null): string | null | undefined {
  const name = node.name?.value
  if (role === null || !CONTENT_NAMED_ROLES.has(role)) return name
  const source = node.name?.sources?.find((candidate) => candidate.value !== undefined && !candidate.superseded)
  return source?.type === "contents" ? undefined : name
}

/** Bound the serialized result, not just node count: page-controlled names can
 * contain entire documents. Keep usable refs and explicitly report omissions.
 *
 * The outline drops what repeats or says nothing: text already in its nearest
 * shown ancestor's name or label, names cells take from their contents,
 * unnamed wrappers and formatting, presentational tables, unnamed leaves, and
 * grouping rows that hold a single non-text row. `depth` counts shown
 * ancestors only, so it is the outline's indentation and scopes match the tree
 * an agent reads. */
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
  /** Stable ref for a DOM node; the same node keeps its ref across reads. */
  refFor?: (backendDOMNodeId: number) => string
}) {
  let truncatedTextFields = 0
  function shorten(value: string, limit: number): string {
    return value.length <= limit ? value : value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "") + "…"
  }
  function text(
    value: string | null | undefined,
    limit: number
  ): string | null {
    if (value === undefined || value === null) return null
    if (value.length > limit) truncatedTextFields++
    return shorten(value, limit)
  }
  // The tab's title and URL describe the page, not its elements: shortening
  // them leaves element text complete.
  const sourceInfo = ObservationInfoSchema.parse(input.info).targetInfo
  const info = {
    targetInfo: {
      ...sourceInfo,
      title: shorten(sourceInfo.title, 500),
      url: shorten(sourceInfo.url, 2048),
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
  // Each node's place in the outline: the depth its children appear at and the
  // name and shown label of its nearest shown named ancestor, whose text it may
  // repeat.
  const outline = new Map<string, { childDepth: number; named: string }>()
  const structural: Array<{
    node: AccessibilityNode
    depth: number
    role: string | null
    properties: Map<string, string>
    interactive: boolean
    informative: boolean
    label: string
  }> = []
  const pending = roots.reverse()
  const visited = new Set<string>()
  while (pending.length) {
    const node = pending.pop()!
    if (visited.has(node.nodeId)) continue
    visited.add(node.nodeId)
    const descendants = children.get(node.nodeId) ?? []
    for (let index = descendants.length - 1; index >= 0; index--)
      pending.push(descendants[index]!)
    const parent = (node.parentId && outline.get(node.parentId)) || { childDepth: 0, named: "" }
    outline.set(node.nodeId, parent)
    if (node.ignored) continue
    const role = node.role?.value ?? null
    if (role !== null && SKIPPED_ROLES.has(role)) continue
    const name = spaced(ownName(node, role))
    const value = node.value?.value
    const properties = propertyMap(node)
    const interactive = isInteractive(role, properties)
    const passThrough =
      !interactive &&
      ((role !== null && DOCUMENT_ROLES.has(role) && !node.parentId) ||
        (role !== null && LAYOUT_ROLE.test(role)) ||
        (role !== null && WRAPPER_ROLES.has(role) && !name && !value) ||
        (role === "StaticText" && (!name || parent.named.includes(name))) ||
        (role !== null && REPEATING_ROLES.has(role) && !!name && !value && parent.named.includes(name)))
    if (passThrough) continue
    const label = role !== null && LABELLED_ROLES.has(role) ? visibleText(node) : ""
    outline.set(node.nodeId, {
      childDepth: parent.childDepth + 1,
      named: name || label ? `${name}\n${label}` : parent.named,
    })
    structural.push({
      node,
      depth: parent.childDepth,
      role,
      properties,
      interactive,
      informative: interactive || name !== "" || (value !== undefined && value !== null && value !== ""),
      label,
    })
  }
  // An unnamed, valueless, inert node says only its role; keep it only while it
  // holds something that says more.
  // Walking the preorder rows backwards, a row's descendants come first:
  // keptAt[d] records a kept row at depth d inside the subtree being closed.
  const kept: typeof structural = []
  const keptAt: boolean[] = []
  for (let index = structural.length - 1; index >= 0; index--) {
    const entry = structural[index]!
    const holds = keptAt.slice(entry.depth + 1).some(Boolean)
    keptAt.length = entry.depth + 1
    if (entry.informative || holds) {
      kept.push(entry)
      keptAt[entry.depth] = true
    }
  }
  kept.reverse()
  // A grouping row that holds a single row adds a line and a level and says
  // nothing; its child takes its place. Text keeps its block, so the text of
  // neighbouring cells or paragraphs never reads as one run.
  const childCount = kept.map(() => 0)
  const open: number[] = []
  kept.forEach((entry, index) => {
    while (open.length && kept[open[open.length - 1]!]!.depth >= entry.depth) open.pop()
    if (open.length) childCount[open[open.length - 1]!]!++
    open.push(index)
  })
  const lifted: Array<{ depth: number; by: number }> = []
  const rows: typeof kept = []
  kept.forEach((entry, index) => {
    while (lifted.length && lifted[lifted.length - 1]!.depth >= entry.depth) lifted.pop()
    const by = lifted[lifted.length - 1]?.by ?? 0
    const collapse =
      !entry.informative &&
      childCount[index] === 1 &&
      kept[index + 1]!.role !== "StaticText" &&
      entry.role !== null &&
      GROUPING_ROLES.has(entry.role)
    lifted.push({ depth: entry.depth, by: by + (collapse ? 1 : 0) })
    if (!collapse) rows.push({ ...entry, depth: entry.depth - by })
  })
  for (const { node, depth, role, properties, interactive, label } of rows) {
    const name = ownName(node, role)
    const value = node.value?.value
    if (input.interactiveOnly && !interactive) continue
    const shown = label && !unspaced(name).includes(unspaced(label)) ? label : undefined
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
    if (interactive && (role === null || !INTERACTIVE_ROLES.has(role))) row.focusable = true
    candidates.push({ node, row })
  }
  const offset = Math.min(input.offset ?? 0, candidates.length)
  const prefix = randomBytes(3).toString("hex")
  const refFor = input.refFor ?? ((id: number) => `${prefix}:${id}`)
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
    const ref = node.backendDOMNodeId ? refFor(node.backendDOMNodeId) : undefined
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

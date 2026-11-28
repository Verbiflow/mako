import { boostPoints, byRank, matchFields, parseQuery, prepare, recencyBoost, TIER, type FieldMatch, type Prepared, type Query, type Ranked } from "@/lib/palette-rank"

/**
 * The palette's search over every row it can show, React-free: what a query finds, in which group, in what order.
 * The rows are made by their sources (`palette-sources.ts`); this ranks them (`palette-rank.ts`) and lays them out.
 */

export type PaletteGroup = "needs" | "threads" | "fins" | "projects" | "pulls" | "automations" | "actions" | "settings" | "models" | "agent" | "files"

/** The groups in the order they're drawn when they match equally well, and what each is headed. */
export const GROUPS: ReadonlyArray<{ id: PaletteGroup; label: string }> = [
  { id: "needs", label: "Needs you" },
  { id: "threads", label: "Threads" },
  { id: "fins", label: "Fins" },
  { id: "projects", label: "Projects" },
  { id: "actions", label: "Actions" },
  { id: "settings", label: "Settings" },
  { id: "automations", label: "Automations" },
  { id: "models", label: "Models" },
  { id: "agent", label: "Agent commands" },
  { id: "pulls", label: "Pull requests" },
  { id: "files", label: "Files" },
]
const GROUP_ORDER = new Map(GROUPS.map((group, index) => [group.id, index]))
export const GROUP_LABEL = new Map(GROUPS.map((group) => [group.id, group.label]))
/** Inside a project with nothing typed: its actions (New Thread there) above its Threads. */
const SCOPED_ORDER = new Map<PaletteGroup, number>((["actions", "needs", "threads", "fins", "automations"] satisfies PaletteGroup[]).map((group, index) => [group, index]))
const EMPTY_ORDER = new Map<PaletteGroup, number>((["needs", "threads", "fins", "actions", "projects", "settings", "automations", "models", "agent", "pulls", "files"] satisfies PaletteGroup[]).map((group, index) => [group, index]))

/** The palette's tabs. ⌘K opens on All, ⌘P on Files; ←/→ with nothing typed moves between them. */
export type PaletteCategory = "all" | "threads" | "pulls" | "automations" | "actions" | "files"

export const CATEGORIES: ReadonlyArray<{ id: PaletteCategory; label: string; placeholder: string; groups: readonly PaletteGroup[] }> = [
  { id: "all", label: "All", placeholder: "Search Threads, projects, actions and settings…", groups: ["needs", "threads", "fins", "projects", "actions", "settings", "automations", "models", "pulls"] },
  { id: "threads", label: "Threads", placeholder: "Search Threads and Fins…", groups: ["needs", "threads", "fins"] },
  { id: "pulls", label: "Pull requests", placeholder: "Search pull requests by title, number, branch or author…", groups: ["pulls"] },
  { id: "automations", label: "Automations", placeholder: "Search automations…", groups: ["automations"] },
  { id: "actions", label: "Actions", placeholder: "Search actions, settings and models…", groups: ["actions", "settings", "models", "agent"] },
  { id: "files", label: "Files", placeholder: "Open a file by name", groups: ["files"] },
]

/**
 * A leading character narrows the search, as typed: `>` actions, `#` pull requests, `@` Threads and Fins, `/` the
 * agent's own commands.
 */
export interface PalettePrefix {
  groups: readonly PaletteGroup[]
  label: string
}

export const PREFIXES = new Map<string, PalettePrefix>([
  [">", { groups: ["actions", "settings", "models"], label: "Actions" }],
  ["#", { groups: ["pulls"], label: "Pull requests" }],
  ["@", { groups: ["threads", "fins"], label: "Threads" }],
  ["/", { groups: ["agent"], label: "Agent commands" }],
])

export type PaletteIcon =
  | { kind: "thread"; harness?: string; state: "idle" | "needs" | "working" | "failed" | "unread"; apex?: boolean }
  | { kind: "fin"; harness?: string; state: "idle" | "needs" | "working" | "failed" | "unread" }
  | { kind: "glyph"; name: GlyphName }
  | { kind: "file"; path: string }

export type GlyphName = "action" | "project" | "pull" | "pull-merged" | "pull-closed" | "automation" | "setting" | "model" | "agent" | "inbox" | "new"

/** Where Tab or → goes from a row: a narrower palette over the same rows (a project's Threads, the models). */
export type PaletteScope = { kind: "project"; path: string; name: string } | { kind: "models" }

export interface PaletteItem {
  /** Unique across the palette, and stable across opens: the memory of picks keys on it. */
  id: string
  group: PaletteGroup
  title: string
  /** What it's searched by, in priority order: the title first. */
  fields: readonly Prepared[]
  /** How many of `fields` count in full; the rest match on word starts only, at half. */
  primary: number
  /** The line beside the title: project and agent, a Fin's Apex, a command's hint. */
  meta?: string
  /** When it last moved, in ms: the time column, and how recently counts. */
  at?: number
  keys?: readonly string[]
  icon: PaletteIcon
  /** The project a row belongs to, for a project scope. */
  project?: string
  scope?: PaletteScope
  /** Status order for the Recent list with nothing typed: lower first (needs you, working, failed, the rest). */
  urgency?: number
  /** Offered with nothing typed, lowest first (Actions' suggestions). */
  suggested?: number
  /** Listed only for a query: a project's settings, a model, an archived Thread. */
  queryOnly?: boolean
  /** ⌘↩: what it does, said in the footer. */
  alternate?: { label: string; run: () => void }
  /** What Enter says in the footer; Open by default. */
  verb?: string
  run: (query: string) => void
}

/** A row ready to draw: its item, the match that found it (to light its characters) and which field it was. */
export interface PaletteRow {
  item: PaletteItem
  match?: FieldMatch
}

export interface PaletteSection {
  group: PaletteGroup
  label: string
  rows: PaletteRow[]
  /** How many more matched than are shown, under All. */
  more: number
}

export interface SearchInput {
  items: readonly PaletteItem[]
  query: string
  category: PaletteCategory
  scope?: PaletteScope
  now: number
  /** The palette's memory of picks and opens, 0…1 for a row and the folded query. */
  boost?: (id: string, query: string) => number
}

/** How many rows a group shows under All, before its tab shows the rest. */
const ALL_LIMIT = new Map<PaletteGroup, number>([
  ["threads", 8],
  ["needs", 5],
])
const ALL_DEFAULT = 5
const TAB_LIMIT = 60
const FEW_GROUPS_LIMIT = 12
/** With nothing typed: the Recent Threads, the suggested actions, the recent projects. */
const EMPTY_LIMIT = new Map<PaletteGroup, number>([
  ["needs", 5],
  ["threads", 6],
  ["fins", 3],
  ["actions", 8],
  ["projects", 3],
  ["automations", 5],
  ["pulls", 8],
])

/** A prefix typed at the start, and the query after it. */
export interface PrefixSplit {
  prefix?: string
  rest: string
}

export function splitPrefix(raw: string): PrefixSplit {
  const first = raw.trimStart()[0]
  if (first && PREFIXES.has(first)) return { prefix: first, rest: raw.trimStart().slice(1) }
  return { rest: raw }
}

function groupsFor(category: PaletteCategory, prefix: string | undefined, scope: PaletteScope | undefined): readonly PaletteGroup[] {
  if (scope?.kind === "models") return ["models"]
  if (scope?.kind === "project") return ["threads", "fins", "actions", "automations"]
  if (prefix) return PREFIXES.get(prefix)?.groups ?? []
  return CATEGORIES.find((entry) => entry.id === category)?.groups ?? []
}

function inScope(item: PaletteItem, scope: PaletteScope | undefined): boolean {
  if (scope?.kind !== "project") return true
  return item.project === scope.path
}

/**
 * What the palette shows for a query. With nothing typed, each group's own order (the sources list Threads newest
 * first; Recent Threads go by urgency then recency, and actions by suggestion and use). With a query, rows rank by
 * tier, then score with their boost, then their source's order; groups by their best row's tier (a coarse class, so
 * one more letter seldom reorders them), ties in the declared order.
 */
export function searchPalette({ items, query, category, scope, now, boost }: SearchInput): PaletteSection[] {
  const { prefix, rest } = splitPrefix(query)
  const allowed = new Set(groupsFor(category, prefix, scope))
  const parsed = parseQuery(rest)
  const limited = category === "all" && !prefix && !scope
  const byGroup = new Map<PaletteGroup, Array<Ranked<PaletteItem>>>()

  if (!parsed.folded) {
    items.forEach((item, order) => {
      if (!allowed.has(item.group) || (item.queryOnly && scope?.kind !== "models") || !inScope(item, scope)) return
      if (!scope && category === "all" && item.group === "actions" && item.suggested === undefined && !(boost?.(item.id, "") ?? 0)) return
      const list = byGroup.get(item.group) ?? []
      list.push({ item, tier: 0, score: emptyScore(item, boost), order, match: { score: 0, tier: 0, field: 0, indices: [] } })
      byGroup.set(item.group, list)
    })
    return lay(byGroup, (group) => (scope || category !== "all" ? TAB_LIMIT : (EMPTY_LIMIT.get(group) ?? ALL_DEFAULT)), scope?.kind === "project" ? "scoped" : "empty")
  }

  items.forEach((item, order) => {
    if (!allowed.has(item.group) || !inScope(item, scope)) return
    const match = matchFields(parsed, item.fields, item.primary)
    if (!match) return
    const lift = Math.min(1, (boost?.(item.id, parsed.folded) ?? 0) + (item.at ? recencyBoost(now - item.at) / 2 : 0))
    const list = byGroup.get(item.group) ?? []
    list.push({ item, tier: classOf(match.tier), score: match.score + boostPoints(lift), order, match })
    byGroup.set(item.group, list)
  })
  // Under All a group shows a few, so several fit; when only one or two matched, they have the room.
  const roomy = byGroup.size <= 2
  return lay(byGroup, (group) => (!limited ? TAB_LIMIT : roomy ? Math.max(FEW_GROUPS_LIMIT, ALL_LIMIT.get(group) ?? 0) : (ALL_LIMIT.get(group) ?? ALL_DEFAULT)), "query")
}

/** The tier a match is classed by: secondary fields' halved tiers fall to the class below their primary tier. */
function classOf(tier: number): number {
  if (tier >= TIER.exact) return 4
  if (tier >= TIER.prefix) return 3
  if (tier >= TIER.word) return 2
  if (tier >= TIER.substring - 100) return 1
  return 0
}

function emptyScore(item: PaletteItem, boost: SearchInput["boost"]): number {
  if (item.group === "threads" || item.group === "fins") return -(item.urgency ?? 9) * 1e13 + (item.at ?? 0)
  if (item.group === "actions") return (boost?.(item.id, "") ?? 0) * 1000 - (item.suggested ?? 50)
  return item.at ?? -(item.suggested ?? 0)
}

function lay(byGroup: Map<PaletteGroup, Array<Ranked<PaletteItem>>>, limit: (group: PaletteGroup) => number, laid: "empty" | "scoped" | "query"): PaletteSection[] {
  const mode = laid === "scoped" ? "empty" : laid
  const sections: Array<PaletteSection & { best: number }> = []
  for (const [group, list] of byGroup) {
    if (!list.length) continue
    list.sort(mode === "empty" ? (left, right) => right.score - left.score || left.order - right.order : byRank)
    const shown = list.slice(0, limit(group))
    sections.push({
      group,
      label: GROUP_LABEL.get(group) ?? group,
      rows: shown.map((ranked) => (mode === "query" ? { item: ranked.item, match: ranked.match } : { item: ranked.item })),
      more: list.length - shown.length,
      best: mode === "query" ? (list[0]?.tier ?? 0) : 0,
    })
  }
  // Pull requests and files arrive from the host after the rest, so they always go last: nothing above moves as
  // they come.
  const late = (group: PaletteGroup) => (group === "pulls" || group === "files" ? 1 : 0)
  // With nothing typed, what to do comes before where to do it: actions above projects.
  const order = laid === "scoped" ? SCOPED_ORDER : mode === "empty" ? EMPTY_ORDER : GROUP_ORDER
  sections.sort((left, right) => late(left.group) - late(right.group) || right.best - left.best || (order.get(left.group) ?? 0) - (order.get(right.group) ?? 0))
  return sections.map((section): PaletteSection => ({ group: section.group, label: section.label, rows: section.rows, more: section.more }))
}

/** The rows in drawing order, for the cursor. */
export function flatRows(sections: readonly PaletteSection[]): PaletteRow[] {
  return sections.flatMap((section) => section.rows)
}

/**
 * A row's fields, prepared once and kept while the text that makes them is the same: a source rebuilt as a catalog
 * changes prepares only what changed (`keepPrepared`), so 5,000 Threads aren't folded again on each.
 */
const prepared = new Map<string, Prepared>()
export function preparedText(text: string): Prepared {
  let held = prepared.get(text)
  if (!held) {
    held = prepare(text)
    if (prepared.size > 50_000) prepared.clear()
    prepared.set(text, held)
  }
  return held
}

export function fieldsOf(...texts: Array<string | undefined>): Prepared[] {
  return texts.filter((text): text is string => Boolean(text)).map(preparedText)
}

export type { Query }

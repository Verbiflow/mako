import { z } from "zod"
import type { AgentAnswer } from "./agent-tools.js"

/** A Shiver mate's topic as the model reads it: what it was asked, cut here. */
export const TOPIC_CHARS = 80

/** How long ago, in one short word a model reads at a glance: "40s", "12m", "3h", "2d". */
export function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/** What compaction reads of a listed Fin (`AgentStrip`, a Shiver mate, a summary row); every other field passes through. */
const ListedRowSchema = z.looseObject({
  name: z.string().optional(),
  title: z.string().optional(),
  runsOn: z.string().optional(),
  model: z.string().optional(),
  origin: z.string().optional(),
  topic: z.string().optional(),
  idleFor: z.number().optional(),
  startedAt: z.number().optional(),
  changedAt: z.number().optional(),
  report: z.looseObject({ at: z.number() }).optional(),
  state: z.looseObject({ since: z.number().optional(), quiet: z.looseObject({ since: z.number() }).optional() }).optional(),
})
type ListedRow = z.infer<typeof ListedRowSchema>
const ListedSchema = z.looseObject({ children: z.array(ListedRowSchema).optional(), shiver: z.array(ListedRowSchema).optional() })

/** What compaction reads of `agents_move`'s answer: each moved Fin's name and the sentence it hears, its other facts JSON. */
const MovedRowSchema = z.object({ name: z.string(), hears: z.string() }).catchall(z.json())
type MovedRow = z.infer<typeof MovedRowSchema>
const MovedSchema = z.looseObject({ moved: z.array(MovedRowSchema) })

const ago = (now: number, at: number) => `${age(now - at)} ago`

function compactState(state: NonNullable<ListedRow["state"]>, now: number) {
  const { since, quiet } = state
  return {
    ...state,
    ...(since !== undefined && { since: ago(now, since) }),
    ...(quiet && { quiet: { ...quiet, since: ago(now, quiet.since) } }),
  }
}

/**
 * One listed Fin as a model reads it: every identity, state, question, wait and pull request kept, the clock readings in
 * words (`idleFor` seconds as `idle`, `report.at` as `report.ago`, a waiting or quiet `since` as its age), and what
 * repeats on every row left out: `startedAt` and `changedAt` (the list's `mark` is what `since` takes), `origin` when it is
 * `started`, `model` beside `runsOn` (which names it), a `title` that is its name or one other rows share, a topic past
 * `TOPIC_CHARS`.
 */
function compactRow(row: ListedRow, now: number, shared: ReadonlySet<string>) {
  const { idleFor, origin, model, title, topic, report, state, ...rest } = row
  delete rest.startedAt
  delete rest.changedAt
  const kept = (value: string | undefined, drop: boolean) => (value !== undefined && !drop ? value : undefined)
  const keptOrigin = kept(origin, origin === "started")
  const keptModel = kept(model, row.runsOn !== undefined)
  const keptTitle = kept(title, title === row.name || (title !== undefined && shared.has(title)))
  const at = report?.at
  const reportRest = { ...report }
  delete reportRest.at
  return {
    ...rest,
    ...(keptOrigin && { origin: keptOrigin }),
    ...(keptModel && { model: keptModel }),
    ...(keptTitle && { title: keptTitle }),
    ...(topic !== undefined && { topic: cut(topic, TOPIC_CHARS) }),
    ...(state && { state: compactState(state, now) }),
    ...(at !== undefined && { report: { ...reportRest, ago: age(now - at) } }),
    ...(idleFor !== undefined && { idle: age(idleFor * 1000) }),
  }
}

/** Titles more than one row carries: a Thread title its Fins inherit says nothing about any one of them. */
function sharedTitles(rows: readonly ListedRow[]): Set<string> {
  const seen = new Map<string, number>()
  for (const { title } of rows) if (title !== undefined) seen.set(title, (seen.get(title) ?? 0) + 1)
  return new Set([...seen].filter(([, count]) => count > 1).map(([title]) => title))
}

function compactRows(rows: readonly ListedRow[], now: number) {
  const shared = sharedTitles(rows)
  return rows.map((row) => compactRow(row, now, shared))
}

/** `agents_list` as a model reads it: `children` and `shiver` rows compacted (`compactRow`); every other field as it was. */
function compactList(answer: AgentAnswer, now: number): AgentAnswer {
  const listed = ListedSchema.safeParse(answer)
  if (!listed.success) return answer
  const { children, shiver } = listed.data
  return { ...answer, ...(children && { children: compactRows(children, now) }), ...(shiver && { shiver: compactRows(shiver, now) }) }
}

/** A moved Fin's row without its ID, the sentence it hears said of "Each" when it begins with its name. */
function movedRow(row: MovedRow): MovedRow {
  const rest = { ...row }
  delete rest["child"]
  return row.hears.startsWith(`${row.name} `) ? { ...rest, hears: `Each ${row.hears.slice(row.name.length + 1)}` } : rest
}

/**
 * `agents_move { all }` as a model reads it: what every moved Fin shares (its harness, where it came from, its state, what
 * it runs on, the sentence it hears, its name aside) said once under `each`, and each row only what differs. The Fins'
 * IDs go: each is named, which every `agents_*` takes. A single move, and every `left` refusal, stay as they were.
 */
function compactMove(answer: AgentAnswer): AgentAnswer {
  const parsed = MovedSchema.safeParse(answer)
  if (!parsed.success || parsed.data.moved.length < 2) return answer
  const { moved } = parsed.data
  const rows = moved.map(movedRow)
  const [first] = rows
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => key !== "name")
  const same = keys.filter((key) => first![key] !== undefined && rows.every((row) => JSON.stringify(row[key]) === JSON.stringify(first![key])))
  const each = Object.fromEntries(same.map((key) => [key, first![key]]))
  const differing = rows.map((row, index) => {
    const own = Object.fromEntries(Object.entries(row).filter(([key]) => !same.includes(key)))
    // A sentence only some Fins hear reads with its own name again.
    return "hears" in own ? { ...own, hears: moved[index]!.hears } : own
  })
  return { ...answer, each, moved: differing }
}

/** What a door says of an operation, cut for the model where it repeats itself; every other answer as it was. */
export function compactAnswer(tool: string | undefined, answer: AgentAnswer, now = Date.now()): AgentAnswer {
  if (answer.refused !== undefined) return answer
  if (tool === "agents_list") return compactList(answer, now)
  if (tool === "agents_move") return compactMove(answer)
  return answer
}

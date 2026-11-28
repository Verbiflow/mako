/**
 * The palette's ranking: what a typed query matches in a row, how well, and which characters to light.
 *
 * Each row is searched by its own fields in priority order (a Thread's title, then its project and agent), never by
 * the name of the group it's listed in: typing "model" once found every model by the section's label. A field
 * matches in one of six tiers, and the best tier of any field is the row's class:
 *
 *   exact 1000 · prefix 800 · word 600 · substring 400 · fuzzy 200 · typo 100
 *
 * A field past the row's `primary` ones (a project, an agent's name) counts only on the word tiers and at half, so a
 * Thread whose project is "api" never outranks one titled "API keys". On top of the tier: how much of the field the
 * query covers and how early it starts (at most 80), and the row's own boost (how recently and how often it was
 * opened, at most 90), so use orders rows within a tier but never lifts one across tiers.
 *
 * A field is prepared once (`prepare`): folded to lowercase without accents, character for character, with its
 * word starts found, so a keystroke over 5,000 Threads is index lookups, not string building.
 */

export const TIER = { exact: 1000, prefix: 800, word: 600, substring: 400, fuzzy: 200, typo: 100 } as const

/** The most a row's own boost adds: less than the gap between two tiers. */
export const BOOST_MAX = 90

export interface Prepared {
  readonly text: string
  /** `text` lowercased and without accents, the same length, so an index into one is an index into the other. */
  readonly folded: string
  /** Where each word starts: after a space or punctuation, at a lower-to-upper change, at a digit after a letter. */
  readonly starts: readonly number[]
}

export interface FieldMatch {
  /** The tier with its coverage and position bonus, halved for a secondary field. */
  score: number
  tier: number
  /** Which field matched, by its place in the row's list. */
  field: number
  /** The matched characters in that field's text. */
  indices: number[]
}

/** One character folded: lowercase, its accent dropped. Always one character, so indices stay aligned. */
function foldChar(char: string): string {
  const lower = char.toLowerCase()
  if (lower.length !== 1) return char.length === 1 ? char : "?"
  if (lower.charCodeAt(0) < 128) return lower
  const base = lower.normalize("NFD")[0] ?? lower
  return base.length === 1 ? base : lower
}

export function fold(text: string): string {
  let out = ""
  for (let i = 0; i < text.length; i += 1) out += foldChar(text[i] ?? "")
  return out
}

const WORD = /[\p{L}\p{N}]/u

export function prepare(text: string): Prepared {
  const folded = fold(text)
  const starts: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? ""
    if (!WORD.test(char)) continue
    const before = i > 0 ? (text[i - 1] ?? "") : ""
    if (
      i === 0 ||
      !WORD.test(before) ||
      (char !== char.toLowerCase() && before === before.toLowerCase() && before !== before.toUpperCase()) ||
      (/\d/.test(char) && !/\d/.test(before))
    )
      starts.push(i)
  }
  return { text, folded, starts }
}

export interface Query {
  readonly raw: string
  /** The whole query, folded and trimmed. */
  readonly folded: string
  /** Its words, folded. */
  readonly tokens: readonly string[]
}

export function parseQuery(raw: string): Query {
  const folded = fold(raw.trim()).replace(/\s+/g, " ")
  return { raw, folded, tokens: folded ? folded.split(" ") : [] }
}

function range(at: number, length: number): number[] {
  return Array.from({ length }, (_, i) => at + i)
}

function bonus(query: number, field: number, at: number): number {
  return Math.round((Math.min(query, field) / Math.max(field, 1)) * 60) + Math.max(0, 20 - at)
}

/** Whether `token` starts a word of `field`, and where; the earliest such word. */
function wordAt(field: Prepared, token: string, from = 0): number {
  for (const start of field.starts) {
    if (start < from) continue
    if (field.folded.startsWith(token, start)) return start
  }
  return -1
}

/**
 * The best tier `query` reaches in one field. `allowLoose` lets substring, fuzzy and typo count, which a
 * secondary field doesn't.
 */
export function matchField(query: Query, field: Prepared, allowLoose: boolean): Omit<FieldMatch, "field"> | null {
  const q = query.folded
  if (!q) return null
  const text = field.folded
  if (text === q) return { tier: TIER.exact, score: TIER.exact + bonus(q.length, text.length, 0), indices: range(0, q.length) }
  if (text.startsWith(q)) return { tier: TIER.prefix, score: TIER.prefix + bonus(q.length, text.length, 0), indices: range(0, q.length) }
  const whole = wordAt(field, q)
  if (whole >= 0) return { tier: TIER.word, score: TIER.word + bonus(q.length, text.length, whole), indices: range(whole, q.length) }
  // Several words, each starting a word of the field, in any order: "light toggle" finds "Toggle light and dark".
  if (query.tokens.length > 1) {
    const indices: number[] = []
    let first = Infinity
    let every = true
    for (const token of query.tokens) {
      const at = wordAt(field, token)
      if (at < 0) {
        every = false
        break
      }
      first = Math.min(first, at)
      indices.push(...range(at, token.length))
    }
    if (every) return { tier: TIER.word, score: TIER.word - 10 + bonus(q.length, text.length, first), indices: [...new Set(indices)].sort((a, b) => a - b) }
  }
  if (!allowLoose) return null
  const inside = text.indexOf(q)
  if (inside >= 0 && q.length >= 2) return { tier: TIER.substring, score: TIER.substring + bonus(q.length, text.length, inside), indices: range(inside, q.length) }
  const loose = fuzzyRuns(q.replace(/ /g, ""), field)
  if (loose) return { tier: TIER.fuzzy, score: TIER.fuzzy + Math.max(0, 60 - 15 * loose.runs) + bonus(q.length, text.length, loose.indices[0] ?? 0), indices: loose.indices }
  const typo = typoWord(query, field)
  if (typo) return { tier: TIER.typo, score: TIER.typo + bonus(q.length, text.length, typo[0] ?? 0), indices: typo }
  return null
}

/**
 * The query's characters in order, each taken at a word start where one comes before the next plain match, so
 * "nt" lights the N of New and the T of thread. At most a run per two characters typed (plus one): past that it's
 * letters scattered through a long title, not something the person meant.
 */
function fuzzyRuns(q: string, field: Prepared): { runs: number; indices: number[] } | null {
  if (q.length < 2) return null
  // Word starts first; where taking one skips past what a later character needs, the plain first matches.
  return fuzzyRunsFrom(q, field, true) ?? fuzzyRunsFrom(q, field, false)
}

function fuzzyRunsFrom(q: string, field: Prepared, preferStarts: boolean): { runs: number; indices: number[] } | null {
  const text = field.folded
  const indices: number[] = []
  let from = 0
  let starts = 0
  for (let i = 0; i < q.length; i += 1) {
    const char = q[i] ?? ""
    const plain = text.indexOf(char, from)
    if (plain < 0) return null
    // Prefer the next word start carrying this character, if the previous match didn't just run into this one.
    let at = plain
    if (preferStarts && (plain !== from || indices.length === 0)) {
      while (starts < field.starts.length && (field.starts[starts] ?? 0) < from) starts += 1
      for (let s = starts; s < field.starts.length; s += 1) {
        const start = field.starts[s] ?? 0
        if (text[start] === char) {
          at = start
          break
        }
      }
      if (text[at] !== char) at = plain
    }
    indices.push(at)
    from = at + 1
  }
  let runs = 1
  for (let i = 1; i < indices.length; i += 1) if ((indices[i] ?? 0) !== (indices[i - 1] ?? 0) + 1) runs += 1
  if (runs > Math.ceil(q.length / 2) + 1) return null
  return { runs, indices }
}

/**
 * A word of five letters or more typed with one slip (two from nine), its first letter right, against a word of the
 * field: "setings" finds Settings. Only for one-word queries, and only where nothing tighter matched.
 */
function typoWord(query: Query, field: Prepared): number[] | null {
  if (query.tokens.length !== 1) return null
  const token = query.tokens[0] ?? ""
  if (token.length < 5) return null
  const allowed = token.length >= 9 ? 2 : 1
  for (const start of field.starts) {
    if (field.folded[start] !== token[0]) continue
    let end = start
    while (end < field.folded.length && WORD.test(field.text[end] ?? "")) end += 1
    const word = field.folded.slice(start, end)
    if (Math.abs(word.length - token.length) > allowed) continue
    if (damerau(token, word, allowed) <= allowed) return range(start, word.length)
  }
  return null
}

/** Optimal string alignment distance, giving up past `limit`. */
export function damerau(a: string, b: string, limit: number): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const d: number[] = Array.from({ length: rows * cols }, () => 0)
  for (let i = 0; i < rows; i += 1) d[i * cols] = i
  for (let j = 0; j < cols; j += 1) d[j] = j
  for (let i = 1; i < rows; i += 1) {
    let best = Infinity
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min((d[(i - 1) * cols + j] ?? 0) + 1, (d[i * cols + j - 1] ?? 0) + 1, (d[(i - 1) * cols + j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, (d[(i - 2) * cols + j - 2] ?? 0) + 1)
      d[i * cols + j] = value
      best = Math.min(best, value)
    }
    if (best > limit) return limit + 1
  }
  return d[rows * cols - 1] ?? limit + 1
}

/** The best match of any of a row's fields: the first `primary` count in full, the rest on the word tiers at half. */
export function matchFields(query: Query, fields: readonly Prepared[], primary: number): FieldMatch | null {
  let best: FieldMatch | null = null
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field || !field.folded) continue
    const isPrimary = index < primary
    const found = matchField(query, field, isPrimary)
    if (!found) continue
    const score = isPrimary ? found.score : Math.round(found.score / 2)
    const tier = isPrimary ? found.tier : Math.round(found.tier / 2)
    if (!best || score > best.score) best = { score, tier, field: index, indices: found.indices }
    if (isPrimary && found.tier === TIER.exact) break
  }
  return best
}

/** How recently a row was used, as a boost: within 4 hours .5, a day .4, three days .3, a week .2, a month .1, 90 days .05. */
export function recencyBoost(ageMs: number): number {
  const hour = 3_600_000
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0
  if (ageMs < 4 * hour) return 0.5
  if (ageMs < 24 * hour) return 0.4
  if (ageMs < 72 * hour) return 0.3
  if (ageMs < 168 * hour) return 0.2
  if (ageMs < 720 * hour) return 0.1
  if (ageMs < 2160 * hour) return 0.05
  return 0
}

/** A boost in 0…1 as the points it adds. */
export function boostPoints(boost: number): number {
  return Math.round(Math.max(0, Math.min(1, boost)) * BOOST_MAX)
}

/**
 * A row's place: tier first (a coarse class, so a little more typed seldom reorders rows within one), then its
 * score with the boost, then the order its source listed it in.
 */
export interface Ranked<T> {
  item: T
  tier: number
  score: number
  order: number
  match: FieldMatch
}

export function byRank<T>(left: Ranked<T>, right: Ranked<T>): number {
  return right.tier - left.tier || right.score - left.score || left.order - right.order
}

/** Split text into lit and unlit runs for drawing a match. */
export function litRuns(text: string, indices: readonly number[]): Array<{ text: string; lit: boolean }> {
  if (!indices.length) return [{ text, lit: false }]
  const lit = new Set(indices)
  const out: Array<{ text: string; lit: boolean }> = []
  let buffer = ""
  let on = lit.has(0)
  for (let i = 0; i < text.length; i += 1) {
    const now = lit.has(i)
    if (now !== on) {
      if (buffer) out.push({ text: buffer, lit: on })
      buffer = ""
      on = now
    }
    buffer += text[i]
  }
  if (buffer) out.push({ text: buffer, lit: on })
  return out
}

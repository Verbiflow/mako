/**
 * Cursor's headless CLI names a model and its settings as one flat id.
 *
 * Over ACP a model is `claude-opus-4-8` with `thinking`, `effort` and `fast`
 * config options. `cursor-agent -p --model` takes none of that: it accepts
 * only the ids `cursor-agent --list-models` prints, such as
 * `claude-opus-4-8-thinking-high-fast`, and answers anything else with
 * "Cannot use this model" followed by the whole list. The bracket syntax its
 * `--help` documents (`claude-opus-4-8[effort=high]`) was rejected in every
 * form on 2026-09-12 (cursor-agent 2026.09.10), including the help's own
 * example. The list is also account-dependent and irregular — `gpt-5.3-codex`
 * is its own medium, Grok gains a `cursor-` prefix, `auto-smart` is `auto` —
 * so the id is chosen from the live list, never composed and hoped for.
 */

import type { SessionModel as HarnessModel } from "@mako/sessions/settings"

const TOKEN_JOINS: readonly string[][] = [["extra", "high"]]

export interface CursorModelSelection {
  model?: string
  options?: Record<string, string | boolean | undefined>
}

/** A selection reduced to what a flat id can say: the base model and its setting tokens. */
export interface CursorSelectionTokens {
  base: string | undefined
  tokens: Set<string>
}

/** The ids `cursor-agent --list-models` prints, in its order. */
export function parseCursorModelList(output: string): string[] {
  const ids: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9][\w.-]*)\s+-\s+\S/.exec(line.trim())
    if (match?.[1]) ids.push(match[1])
  }
  return ids
}

/**
 * Base id and settings from a selection. The bracket form Mako once wrote
 * (`opus[effort=high]`) is still read so a saved preference keeps its meaning.
 */
export function parseCursorSelection(selection: CursorModelSelection): CursorSelectionTokens {
  const identity = selection.model
  const bracket = identity?.indexOf("[") ?? -1
  const base = identity === undefined ? undefined : bracket < 0 ? identity : identity.slice(0, bracket)
  const parameters = new Map<string, string>()
  if (identity !== undefined && bracket >= 0 && identity.endsWith("]")) {
    for (const entry of identity.slice(bracket + 1, -1).split(",")) {
      const separator = entry.indexOf("=")
      if (separator < 0) parameters.set(entry, "true")
      else parameters.set(entry.slice(0, separator), entry.slice(separator + 1))
    }
  }
  for (const [key, value] of Object.entries(selection.options ?? {})) {
    if (value === undefined) continue
    parameters.set(key, String(value))
  }
  const tokens = new Set<string>()
  const level =
    parameters.get("effort") ?? parameters.get("reasoning") ?? parameters.get("reasoning_effort")
  if (level) tokens.add(level)
  if (parameters.get("thinking") === "true") tokens.add("thinking")
  if (parameters.get("fast") === "true") tokens.add("fast")
  return { base: base || undefined, tokens }
}

/** A listed id chosen for a selection, and the level it left unstated when the bare id is that level. */
export interface CursorCliModel {
  id: string
  /** Set when the requested level is unlisted for this model and the bare id is its default. */
  bareLevel?: string
}

/**
 * The listed id that carries this base model with exactly the requested
 * settings. The model's default level may be its bare id (`gpt-5.3-codex`
 * is medium with no suffix): when the requested level is the catalog's
 * default and no id of the model spells it, the bare id answers and says
 * so. Anything else — a level the model lacks with thinking, a model the
 * account does not list — is `undefined`; nothing is rounded to a neighbour.
 */
export function resolveCursorCliModel(
  selection: CursorModelSelection,
  available: readonly string[],
  defaultLevel?: string
): CursorCliModel | undefined {
  const { base, tokens } = parseCursorSelection(selection)
  if (!base) return undefined
  const candidates = available.flatMap((id) => {
    const rest = remainder(id, base)
    return rest === undefined ? [] : [{ id, tokens: tokenize(rest) }]
  })
  const level = [...tokens].find((token) => !FLAG_TOKENS.has(token))
  const spelled = level === undefined ? undefined : levelSpelling(level, candidates)
  const requested = new Set(tokens)
  if (level !== undefined && spelled !== undefined) {
    requested.delete(level)
    requested.add(spelled)
  }
  const exact = candidates.find((candidate) => sameTokens(candidate.tokens, requested))
  if (exact) return { id: exact.id }
  if (level === undefined || spelled !== undefined || level !== defaultLevel) return undefined
  requested.delete(level)
  const bare = candidates.find((candidate) => sameTokens(candidate.tokens, requested))
  return bare ? { id: bare.id, bareLevel: level } : undefined
}

/**
 * Cursor names one level two ways: `extra-high` in a session's config
 * options, `xhigh` in some command-line ids (gpt-5.3-codex on 2026-09-12;
 * gpt-5.5 keeps `extra-high`). The requested spelling wins when the model
 * lists it; the other is used only when the model lists that one instead.
 */
const LEVEL_SPELLINGS: ReadonlyMap<string, string> = new Map([
  ["extra-high", "xhigh"],
  ["xhigh", "extra-high"],
])

function levelSpelling(
  level: string,
  candidates: readonly { tokens: string[] }[]
): string | undefined {
  if (candidates.some((candidate) => candidate.tokens.includes(level))) return level
  const other = LEVEL_SPELLINGS.get(level)
  return other !== undefined && candidates.some((candidate) => candidate.tokens.includes(other))
    ? other
    : undefined
}

/** What a listed id says: the model it names and the settings its suffix spells. */
export type CursorStatedOptions = { thinking: string; fast: string; effort?: string }
export interface CursorCliReading {
  model: string
  options: CursorStatedOptions
}

/**
 * The selection a listed id states, read back against the catalog: the
 * longest model id that prefixes it owns it, and a level is reported in the
 * spelling that model's own effort option uses. A level is reported only
 * when the id carries one; a bare id says nothing about its level.
 */
export function describeCursorCliModel(
  id: string,
  catalog: readonly HarnessModel[]
): CursorCliReading {
  const models = [...catalog].sort((left, right) => right.id.length - left.id.length)
  for (const model of models) {
    const rest = remainder(id, model.id)
    if (rest === undefined) continue
    const tokens = tokenize(rest)
    const options: CursorStatedOptions = {
      thinking: String(tokens.includes("thinking")),
      fast: String(tokens.includes("fast")),
    }
    const level = tokens.find((token) => !FLAG_TOKENS.has(token))
    if (level !== undefined) options.effort = catalogSpelling(level, model)
    return { model: model.id, options }
  }
  return { model: id, options: { thinking: "false", fast: "false" } }
}

/** The level as the model's own effort option spells it, when the two surfaces differ. */
function catalogSpelling(level: string, model: HarnessModel): string {
  const listed = model.options.find((option) => option.id === "effort")
  if (!listed || listed.kind !== "select") return level
  const values = listed.values.map((value) => value.value)
  if (values.includes(level)) return level
  const other = LEVEL_SPELLINGS.get(level)
  return other !== undefined && values.includes(other) ? other : level
}

const FLAG_TOKENS: ReadonlySet<string> = new Set(["thinking", "fast"])

function sameTokens(listed: readonly string[], requested: ReadonlySet<string>): boolean {
  return listed.length === requested.size && listed.every((token) => requested.has(token))
}

function remainder(id: string, base: string): string | undefined {
  for (const prefix of [base, `cursor-${base}`]) {
    if (id === prefix) return ""
    if (id.startsWith(`${prefix}-`)) return id.slice(prefix.length + 1)
  }
  // `auto-smart` over ACP is `auto` on the command line.
  if (base.startsWith(`${id}-`)) return ""
  return undefined
}

function tokenize(rest: string): string[] {
  if (!rest) return []
  const parts = rest.split("-")
  const tokens: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const join = TOKEN_JOINS.find(
      (pair) => pair[0] === parts[index] && pair[1] === parts[index + 1]
    )
    if (join) {
      tokens.push(join.join("-"))
      index += 1
    } else tokens.push(parts[index] ?? "")
  }
  return tokens
}

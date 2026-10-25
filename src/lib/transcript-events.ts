import {
  COMPACTION_FAILED,
  CONTEXT_COMPACTED,
  durationText,
  INTERRUPTED,
  MCP_SERVER_FAILED,
  retriesLabel,
  TURN_ENDED,
  TURN_FAILED,
  type EventTone,
  type TranscriptEvent,
  type TurnCause,
} from "@mako/sessions/events"

/**
 * What the transcript says for each event it draws between messages, in
 * words a person would write. Everything here is read from structured
 * fields (`TurnCause`, the shared marker labels); a provider's own sentence
 * is kept for the reader to open, never parsed.
 *
 * Every event is one of four kinds, each drawn one way:
 * - a cause: background work settled and the provider started a turn on it,
 *   drawn where a prompt would stand;
 * - Mako's own line: a turn Mako started (a continuation, a move, a goal);
 * - ambient: a state change inside a turn (compaction, model, review mode,
 *   a provider's retries it recovered from);
 * - attention: something failed or wants a person (`tone`).
 */
export type EventGlyph =
  | "command"
  | "agent"
  | "monitor"
  | "task"
  | "goal"
  | "compaction"
  | "model"
  | "stop"
  | "review"
  | "history"
  | "mcp"
  | "rules"
  | "plugin"
  | "hook"
  | "key"
  | "limit"
  | "retry"
  | "notice"
  | "warning"
  | "error"

export interface EventWords {
  glyph: EventGlyph
  /** The sentence: what happened. */
  title: string
  /** What it happened to, quieter, and the first thing to give way. */
  detail?: string
  /** A short measure that never gives way, after the detail: how long the work ran. */
  aside?: string
  /** Set only when it wants attention. */
  tone?: EventTone
}

/** Words with only the fields they have. */
function said(glyph: EventGlyph, title: string, detail?: string, tone?: EventTone): EventWords {
  const words: EventWords = { glyph, title }
  if (detail) words.detail = detail
  if (tone) words.tone = tone
  return words
}

/** `words` with how long the work ran, when that is known and at least a second. */
function timed(words: EventWords, durationMs: number | undefined): EventWords {
  if (durationMs !== undefined && durationMs >= 1000) words.aside = durationText(durationMs)
  return words
}

/** Background work that settled, as one line. `provider` names the harness for a turn it took toward a goal. */
export function causeWords(cause: TurnCause, provider?: string): EventWords {
  switch (cause.kind) {
    case "command":
      return timed(commandWords(cause), cause.durationMs)
    case "agent":
      return timed(
        cause.outcome === "failed"
          ? said("agent", "Agent failed", cause.name, "error")
          : said("agent", cause.outcome === "stopped" ? "Agent stopped" : "Agent finished", cause.name),
        cause.durationMs
      )
    case "monitor":
      // What it reported is the news; the watch it came from is the detail.
      if (cause.output) return said("monitor", cause.output, cause.outcome === "ended" ? [cause.name, "stopped watching"].filter(Boolean).join(" · ") : cause.name)
      return said("monitor", cause.outcome === "ended" ? "Monitor stopped watching" : "Monitor reported", cause.name)
    case "task":
      return timed(said("task", cause.outcome === "progress" ? "Background task reported progress" : "Background task finished", cause.name), cause.durationMs)
    case "goal":
      return said("goal", provider ? `${provider} continued toward the goal` : "Continued toward the goal", cause.objective)
  }
}

/** A clean exit says nothing of its code; a failed one says which, as the person asked: "failed (exit 2)". */
function commandWords(cause: Extract<TurnCause, { kind: "command" }>): EventWords {
  switch (cause.outcome) {
    case "failed":
      return said("command", cause.exitCode === undefined ? "Background command failed" : `Background command failed (exit ${cause.exitCode})`, cause.name, "error")
    case "stopped":
      return said("command", cause.signal ? `Background command stopped (${cause.signal})` : "Background command stopped", cause.name)
    case "unfinished":
      return said("command", "Background command didn't finish", cause.name ?? "its session ended first")
    case "finished":
      return said("command", "Background command finished", cause.name)
  }
}

/** The separator a server's name and its reason share in `mcpServerFailedEvent`'s detail. */
const SERVER_SEPARATOR = " · "

function mcpServer(note: TranscriptEvent): { server: string; reason?: string } {
  const [server = "", ...reason] = (note.detail ?? "").split(SERVER_SEPARATOR)
  return reason.length ? { server, reason: reason.join(SERVER_SEPARATOR) } : { server }
}

/** Labels whose words are a category, not a sentence: the detail says what happened. */
const GENERIC_LABELS = new Set(["Warning", "Notice"])

const LABEL_GLYPHS: ReadonlyMap<string, EventGlyph> = new Map([
  [CONTEXT_COMPACTED, "compaction"],
  [COMPACTION_FAILED, "compaction"],
  ["Model changed", "model"],
  [INTERRUPTED, "stop"],
  [TURN_ENDED, "stop"],
  [TURN_FAILED, "error"],
  ["Review mode started", "review"],
  ["Review mode ended", "review"],
  ["Earlier history not shown", "history"],
  ["History read limit reached", "history"],
  ["History unavailable", "history"],
  ["Message unavailable", "history"],
  [MCP_SERVER_FAILED, "mcp"],
  ["Grok permission rules", "rules"],
  ["Hook", "hook"],
  ["Rate limited", "limit"],
  ["Quota exhausted", "limit"],
  ["Authentication failed", "key"],
  ["Sign-in required", "key"],
])

function glyphOf(note: TranscriptEvent): EventGlyph {
  const known = LABEL_GLYPHS.get(note.label)
  if (known) return known
  if (note.label.endsWith(" plugin didn't load")) return "plugin"
  return note.tone ?? "notice"
}

/** A provider's marker inside a turn, as one line. */
export function eventWords(note: TranscriptEvent): EventWords {
  if (note.cause) {
    const words = causeWords(note.cause)
    if (note.tone && !words.tone) words.tone = note.tone
    return words
  }
  // A provider's retries: the outcome and how many, the provider's words for what failed, and how long they took.
  if (note.retries) return timed(said("retry", retriesLabel(note.retries), note.detail, note.tone), note.retries.durationMs)
  if (note.label === MCP_SERVER_FAILED) {
    const { server, reason } = mcpServer(note)
    return said("mcp", server ? `MCP server ${server} didn't start` : "An MCP server didn't start", reason, note.tone)
  }
  if (GENERIC_LABELS.has(note.label) && note.detail) return said(glyphOf(note), note.detail, undefined, note.tone)
  return said(glyphOf(note), note.label, note.detail, note.tone)
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

function strongest(notes: readonly TranscriptEvent[]): EventTone | undefined {
  return notes.some((note) => note.tone === "error") ? "error" : notes.some((note) => note.tone === "warning") ? "warning" : undefined
}

/**
 * Setup notices that arrived together, as one line that opens onto each:
 * "3 MCP servers need sign-in · wisprflow, todoist, axiom".
 */
export function setupWords(notes: readonly TranscriptEvent[]): EventWords {
  if (notes.length === 1) return eventWords(notes[0]!)
  const servers = notes.filter((note) => note.label === MCP_SERVER_FAILED).map(mcpServer)
  const others = notes.filter((note) => note.label !== MCP_SERVER_FAILED)
  const tone = strongest(notes)
  if (!servers.length)
    return said(tone ?? "notice", plural(others.length, "setup notice"), others.map((note) => eventWords(note).title).join(", "), tone)
  const reasons = new Set(servers.map((server) => server.reason))
  const title =
    servers.length === 1
      ? `MCP server ${servers[0]!.server} didn't start`
      : reasons.size === 1 && servers[0]!.reason === "sign-in required"
        ? `${servers.length} MCP servers need sign-in`
        : `${servers.length} MCP servers didn't start`
  const names = servers.length === 1 ? servers[0]!.reason : servers.map((server) => server.server).join(", ")
  const rest = others.length ? plural(others.length, "other setup notice") : undefined
  return said("mcp", title, [names, rest].filter(Boolean).join(" · "), tone)
}

/**
 * A usage limit's line with the work it refused folded under it
 * (`foldUsageLimits`): "Rate limited · Reached your 5-hour limit · resets
 * 3:20 AM · 6 agents stopped". `refused` are the causes of the turns the
 * provider started on its own that the limit refused.
 */
export function limitWords(note: TranscriptEvent, refused: readonly TurnCause[]): EventWords {
  const words = eventWords(note)
  const agents = refused.filter((cause) => cause.kind === "agent").length
  const others = refused.length - agents
  const folded = [
    agents ? `${plural(agents, "agent")} stopped` : undefined,
    others ? `${plural(others, "background report")} not answered` : undefined,
  ]
  const detail = [words.detail, ...folded].filter(Boolean).join(" · ")
  if (detail) words.detail = detail
  return words
}

/** One line for a navigator or a label: the words without their glyph. */
export function eventLabel(words: EventWords): string {
  return [words.title, words.detail, words.aside].filter(Boolean).join(" · ")
}

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { grokHome, grokWorkspaceCwd } from "@mako/sessions"
import { grokCost, grokLineMillis, grokTokens, grokTurnsBetween, GrokTurnUsage, grokUnrecorded, grokWakingChild, type GrokTurnRecord } from "@mako/sessions/harnesses"
import { z } from "zod"
import { numberValue, objectValue, stringValue } from "../../base/json-values.js"
import {
  fingerprint,
  parseObject,
  tokenTotal,
  usageCounts,
  type JsonlReader,
  type UsageEvent,
  type ProviderUsageHistory,
} from "../../usage/index.js"

/** Grok writes each session's live transcript here; its siblings repeat it or hold no usage. */
const GROK_UPDATES = "updates.jsonl"

const GrokSummary = z.object({ session_kind: z.string().nullish() }).catch({})

/**
 * A session file's place: when its last turn ended (epoch ms), and the
 * subagents that woke it since, each with the span of its turns, which count
 * with the session's next turn (`GrokWokenSpend`). An older cursor's `null`
 * reads as a file with neither.
 */
const GrokScanState = z.object({
  ended: z.number().nullable(),
  woken: z.array(z.object({ child: z.string(), after: z.number().nullable(), until: z.number().nullable() })),
})
type GrokScanState = z.infer<typeof GrokScanState>
const START: GrokScanState = { ended: null, woken: [] }

export const grokUsageHistory: ProviderUsageHistory = {
  provider: "grok",
  async scan(scan) {
    const sessions = new Map<string, GrokSession>()
    const session = (file: string): GrokSession => {
      const folder = dirname(file)
      let found = sessions.get(folder)
      if (!found) sessions.set(folder, found = grokSession(folder))
      return found
    }
    const reader: JsonlReader<GrokScanState> = {
      needles: ['"turn_completed"', '"subagent_finished"'],
      start: () => ({ ...START, woken: [] }),
      restore: (state) => state === null ? { ...START, woken: [] } : GrokScanState.parse(state),
      line: (line, state, file) => {
        const { subagent, cwd } = session(file.path)
        if (subagent) return []
        const root = parseObject(line)
        const params = objectValue(root?.params)
        const update = objectValue(params?.update)
        const at = grokLineMillis(root) ?? null
        const child = grokWakingChild(update)
        if (child) {
          state.woken.push({ child, after: state.ended, until: at })
          return []
        }
        const events = parseGrokTurn(scan.source, line, cwd, file.mtimeMs)
        if (stringValue(update?.sessionUpdate) !== "turn_completed") return events
        // The subagent turns that woke this one count with it, from each subagent's own session, as this session's.
        const owner = stringValue(params?.sessionId) ?? "unknown"
        const woken = state.woken.flatMap(({ child: id, after, until }) => childTurns(file.path, id, after, until).map((turn) =>
          grokTurnEvents(scan.source, turn.usage, owner, `${id}:${turn.prompt ?? turn.at}`, turn.at, cwd)))
        state.woken = []
        state.ended = at ?? state.ended
        return [...events, ...woken.flat()]
      },
    }
    await scan.jsonl([join(grokHome(scan.env, scan.homeRoot), "sessions")], reader, GROK_UPDATES)
  },
}

/** A subagent's turns in its own session beside the session at `path`, ended after `after` and by `until` (epoch ms). */
function childTurns(path: string, child: string, after: number | null, until: number | null): GrokTurnRecord[] {
  // The id is the store's own data; it names a folder beside the session's and nothing else.
  if (!/^[\w-]+$/.test(child)) return []
  let text: string
  try {
    text = readFileSync(join(dirname(dirname(path)), child, GROK_UPDATES), "utf8")
  } catch {
    return []
  }
  return grokTurnsBetween(text, child, after ?? undefined, until ?? undefined)
}

interface GrokSession {
  /**
   * A subagent's session, whose turns count through its parent's: those it ran while a parent turn ran are in that
   * turn's count, and those after are read when it wakes the parent (`GrokWokenSpend`).
   */
  subagent: boolean
  cwd: string
}

/** sessions/<workspace>/<session id>/: the session's `summary.json` and its workspace's folder. */
function grokSession(folder: string): GrokSession {
  let kind: string | null | undefined
  try {
    kind = GrokSummary.parse(JSON.parse(readFileSync(join(folder, "summary.json"), "utf8"))).session_kind
  } catch {
    kind = undefined
  }
  return { subagent: kind?.startsWith("subagent") ?? false, cwd: grokWorkspaceCwd(dirname(folder)) ?? "unknown" }
}


/** One event per model a turn used. */
function parseGrokTurn(source: string, line: string, cwd: string, fallbackTime: number): UsageEvent[] {
  const root = parseObject(line)
  const params = objectValue(root?.params)
  const update = objectValue(params?.update)
  if (!root || !params || !update || stringValue(update.sessionUpdate) !== "turn_completed") return []
  const usage = GrokTurnUsage.safeParse(update.usage).data
  if (!usage) return []
  const session = stringValue(params.sessionId) ?? "unknown"
  const turn = stringValue(update.prompt_id) ?? fingerprint(String(root.timestamp), session, usageCounts(grokTokens(usage)))
  const seconds = numberValue(root.timestamp)
  return grokTurnEvents(source, usage, session, turn, seconds !== undefined && seconds > 0 ? (seconds < 10_000_000_000 ? seconds * 1000 : seconds) : fallbackTime, cwd)
}

/** One event per model a turn of `session` used, keyed by `turn`; `at` is when it ended, in epoch ms. */
function grokTurnEvents(source: string, usage: GrokTurnUsage, session: string, turn: string, at: number, cwd: string): UsageEvent[] {
  const timestamp = new Date(at).toISOString()
  const perModel = Object.entries(usage.modelUsage ?? {}).flatMap(([model, spend]) => spend ? [[model, spend] as const] : [])
  // A turn whose cost alone Grok left out leaves the summary an estimate, and nothing for a model without a price.
  const incomplete = grokUnrecorded(usage) !== undefined
  return (perModel.length ? perModel : [["unknown", usage] as const]).flatMap(([model, spend]) => {
    const tokens = usageCounts(grokTokens(spend))
    const cost = grokCost(spend)
    if (tokenTotal(tokens) === 0 && !cost && !incomplete) return []
    const event: UsageEvent = {
      ...tokens,
      key: `${source}:${session}:${turn}:${model}`,
      source,
      session,
      timestamp,
      model,
      cwd,
    }
    if (cost !== undefined) event.reportedCost = cost
    if (incomplete) event.incomplete = true
    return [event]
  })
}

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { grokHome, grokWorkspaceCwd } from "@mako/sessions"
import { grokCost, grokTokens, GrokTurnUsage, grokUnrecorded } from "@mako/sessions/harnesses"
import { z } from "zod"
import { numberValue, objectValue, stringValue } from "../../codex-app-json.js"
import {
  fingerprint,
  parseObject,
  tokenTotal,
  usageCounts,
  type JsonlReader,
  type UsageEvent,
} from "../../usage-scan.js"
import type { ProviderUsageHistory } from "../usage-history.js"

/** Grok writes each session's live transcript here; its siblings repeat it or hold no usage. */
const GROK_UPDATES = "updates.jsonl"

const GrokSummary = z.object({ session_kind: z.string().nullish() }).catch({})

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
    const reader: JsonlReader<null> = {
      needles: ['"turn_completed"'],
      start: () => null,
      restore: (state) => z.null().parse(state),
      line: (line, _state, file) => {
        const { subagent, cwd } = session(file.path)
        return subagent ? [] : parseGrokTurn(scan.source, line, cwd, file.mtimeMs)
      },
    }
    await scan.jsonl([join(grokHome(scan.env, scan.homeRoot), "sessions")], reader, GROK_UPDATES)
  },
}

interface GrokSession {
  /** Grok adds a subagent's usage to its parent's turn (`UsageLedger::record_subagent`), so its own turns would count it twice. */
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
  const timestamp = seconds !== undefined && seconds > 0
    ? new Date(seconds < 10_000_000_000 ? seconds * 1000 : seconds).toISOString()
    : new Date(fallbackTime).toISOString()
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

import { readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import { numberValue, objectValue, stringValue, type JsonObject } from "../../codex-app-json.js"
import {
  fingerprint,
  parseObject,
  tokenTotal,
  tokenValue,
  type JsonlReader,
  type UsageEvent,
} from "../../usage-scan.js"
import type { UsageTokenCounts } from "../../usage-pricing.js"
import type { ProviderUsageHistory } from "../usage-history.js"

/** Grok writes each session's live transcript here; its siblings repeat it or hold no usage. */
const GROK_UPDATES = "updates.jsonl"

/** Grok's own unit: `costUsdTicks` are ten-billionths of a dollar. */
const GROK_TICKS_PER_USD = 1e10

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
    await scan.jsonl([join(scan.homeRoot, ".grok", "sessions")], reader, GROK_UPDATES)
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
  return { subagent: kind?.startsWith("subagent") ?? false, cwd: workspaceCwd(dirname(folder)) }
}

/**
 * Grok names a workspace folder by its URL-encoded path, or, past 255 bytes,
 * by a `slug-hash` with the path in `.cwd` (`decode_cwd_from_dirname`, xai-grok-config).
 */
function workspaceCwd(folder: string): string {
  try {
    const decoded = decodeURIComponent(basename(folder))
    if (decoded.startsWith("/")) return decoded
  } catch {
    // A slug-hash name is not URL-encoded; its path is in `.cwd`.
  }
  try {
    return readFileSync(join(folder, ".cwd"), "utf8").trim() || "unknown"
  } catch {
    return "unknown"
  }
}

/** One event per model a turn used; Grok counts cached input inside `inputTokens`. */
function parseGrokTurn(source: string, line: string, cwd: string, fallbackTime: number): UsageEvent[] {
  const root = parseObject(line)
  const params = objectValue(root?.params)
  const update = objectValue(params?.update)
  const usage = objectValue(update?.usage)
  if (!root || !params || !update || !usage || stringValue(update.sessionUpdate) !== "turn_completed") return []
  const session = stringValue(params.sessionId) ?? "unknown"
  const turn = stringValue(update.prompt_id) ?? fingerprint(String(root.timestamp), session, grokCounts(usage))
  const seconds = numberValue(root.timestamp)
  const timestamp = seconds !== undefined && seconds > 0
    ? new Date(seconds < 10_000_000_000 ? seconds * 1000 : seconds).toISOString()
    : new Date(fallbackTime).toISOString()
  const perModel = Object.entries(objectValue(usage.modelUsage) ?? {})
    .flatMap(([model, value]) => {
      const counts = objectValue(value)
      return counts ? [[model, counts] as const] : []
    })
  return (perModel.length ? perModel : [["unknown", usage] as const]).flatMap(([model, counts]) => {
    const tokens = grokCounts(counts)
    const ticks = numberValue(counts.costUsdTicks)
    if (tokenTotal(tokens) === 0 && !ticks) return []
    const event: UsageEvent = {
      ...tokens,
      key: `${source}:${session}:${turn}:${model}`,
      source,
      session,
      timestamp,
      model,
      cwd,
    }
    if (ticks !== undefined && ticks >= 0) event.reportedCost = ticks / GROK_TICKS_PER_USD
    return [event]
  })
}

function grokCounts(usage: JsonObject): UsageTokenCounts {
  const cacheRead = tokenValue(usage.cachedReadTokens)
  const cacheWrite = tokenValue(usage.cacheCreationTokens)
  return {
    input: Math.max(0, tokenValue(usage.inputTokens) - cacheRead - cacheWrite),
    output: tokenValue(usage.outputTokens),
    cacheRead,
    cacheWrite,
  }
}

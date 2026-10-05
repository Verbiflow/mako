import { basename, dirname, join } from "node:path"
import { numberValue, objectValue, stringValue, type JsonObject } from "../../codex-app-json.js"
import {
  discover,
  fingerprint,
  parseObject,
  readLines,
  tokenTotal,
  tokenValue,
  yieldToMain,
  type UsageEvent,
} from "../../usage-scan.js"
import type { UsageTokenCounts } from "../../usage-pricing.js"
import type { ProviderUsageHistory } from "../usage-history.js"

/** Grok writes each session's live transcript here; its siblings repeat it or hold no usage. */
const GROK_UPDATES = "updates.jsonl"

/** Grok's own unit: `costUsdTicks` are ten-billionths of a dollar. */
const GROK_TICKS_PER_USD = 1e10


export const grokUsageHistory: ProviderUsageHistory = {
  provider: "grok",
  async scan(scan) {
    const { files, truncated } = await discover([join(scan.homeRoot, ".grok", "sessions")], GROK_UPDATES)
    for (const [index, file] of files.entries()) {
      // sessions/<url-encoded cwd>/<session id>/updates.jsonl
      const cwd = decodedDirectory(basename(dirname(dirname(file.path))))
      const read = await readLines(file, (line) => {
        if (!line.includes('"turn_completed"')) return
        for (const event of parseGrokTurn(scan.source, line, cwd, file.mtimeMs)) scan.record(event)
      })
      if (read) scan.session(basename(dirname(file.path)))
      if ((index + 1) % 8 === 0) await yieldToMain()
    }
    return { truncated }
  },
}

function decodedDirectory(name: string): string {
  try {
    const decoded = decodeURIComponent(name)
    return decoded.startsWith("/") ? decoded : "unknown"
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

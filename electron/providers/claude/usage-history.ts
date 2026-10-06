import { basename, join } from "node:path"
import { z } from "zod"
import { objectValue, stringValue } from "../../codex-app-json.js"
import {
  fingerprint,
  parseObject,
  tokenCounts,
  tokenTotal,
  tokenValue,
  validTimestamp,
  type JsonlReader,
  type UsageEvent,
} from "../../usage-scan.js"
import type { ProviderUsageHistory } from "../usage-history.js"

export const claudeUsageHistory: ProviderUsageHistory = {
  provider: "claude",
  async scan(scan) {
    const reader: JsonlReader<null> = {
      needles: ['"usage"'],
      start: () => null,
      restore: (state) => z.null().parse(state),
      line: (line, _state, file) => parseClaudeEvent(scan.source, line, basename(file.path, ".jsonl"), file.mtimeMs),
    }
    await scan.jsonl([join(scan.homeRoot, ".claude", "projects"), join(scan.homeRoot, ".claude", "transcripts")], reader)
  },
}

function parseClaudeEvent(
  source: string,
  line: string,
  fallbackSession: string,
  fallbackTime: number
): UsageEvent | null {
  const root = parseObject(line)
  const message = objectValue(root?.message)
  const usage = objectValue(message?.usage)
  if (!root || stringValue(root.type) !== "assistant" || !message || !usage)
    return null
  const counts = tokenCounts(
    usage,
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens"
  )
  if (tokenTotal(counts) === 0) return null
  const hour = tokenValue(objectValue(usage.cache_creation)?.ephemeral_1h_input_tokens)
  if (hour) counts.cacheWrite1h = hour
  const timestamp = validTimestamp(root.timestamp, fallbackTime)
  const messageId = stringValue(message.id)
  const requestId = stringValue(root.requestId)
  const uuid = stringValue(root.uuid)
  const stableId =
    messageId && requestId
      ? `${messageId}:${requestId}`
      : messageId
        ? `message:${messageId}`
        : uuid
          ? `row:${uuid}`
          : fingerprint(timestamp, stringValue(message.model), counts)
  return {
    ...counts,
    key: `${source}:${stableId}`,
    source,
    session:
      stringValue(root.sessionId) ?? stringValue(root.session_id) ?? fallbackSession,
    timestamp,
    model: stringValue(message.model) ?? "unknown",
    cwd: stringValue(root.cwd) ?? "unknown",
  }
}

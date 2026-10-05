import { basename, join } from "node:path"
import { objectValue, stringValue } from "../../codex-app-json.js"
import {
  discover,
  fingerprint,
  parseObject,
  readLines,
  tokenCounts,
  tokenTotal,
  validTimestamp,
  yieldToMain,
  type UsageEvent,
} from "../../usage-scan.js"
import type { ProviderUsageHistory } from "../usage-history.js"

export const claudeUsageHistory: ProviderUsageHistory = {
  provider: "claude",
  async scan(scan) {
    const { files, truncated } = await discover([
      join(scan.homeRoot, ".claude", "projects"),
      join(scan.homeRoot, ".claude", "transcripts"),
    ])
    for (const [index, file] of files.entries()) {
      const fallbackSession = basename(file.path, ".jsonl")
      await readLines(file, (line) => {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) return
        const event = parseClaudeEvent(scan.source, line, fallbackSession, file.mtimeMs)
        if (!event) return
        scan.session(event.session)
        scan.record(event)
      })
      if ((index + 1) % 8 === 0) await yieldToMain()
    }
    return { truncated }
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

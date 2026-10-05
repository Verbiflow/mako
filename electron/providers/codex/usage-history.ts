import { basename, join } from "node:path"
import { objectValue, stringValue, type JsonObject, type JsonValue } from "../../codex-app-json.js"
import type { UsageTokenCounts } from "../../usage-pricing.js"
import {
  discover,
  MAX_BYTES_PER_FILE,
  parseObject,
  readLines,
  tokenValue,
  validTimestamp,
  yieldToMain,
  type UsageEvent,
} from "../../usage-scan.js"
import type { ProviderUsageHistory } from "../usage-history.js"

interface RawCodexUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface CodexContext {
  session: string
  cwd: string
  model: string
  previous: RawCodexUsage | null
  partial: boolean
}

export const codexUsageHistory: ProviderUsageHistory = {
  provider: "codex",
  async scan(scan) {
    const { files, truncated } = await discover([join(scan.homeRoot, ".codex", "sessions")])
    for (const [index, file] of files.entries()) {
      const context: CodexContext = {
        session: basename(file.path, ".jsonl"),
        cwd: "unknown",
        model: "unknown",
        previous: null,
        partial: file.size > MAX_BYTES_PER_FILE,
      }
      const read = await readLines(file, (line) => {
        if (
          !line.includes('"session_meta"') &&
          !line.includes('"turn_context"') &&
          !line.includes('"token_count"')
        )
          return
        const event = parseCodexRecord(scan.source, line, context, file.mtimeMs)
        if (event) scan.record(event)
      })
      if (read) scan.session(context.session)
      if ((index + 1) % 8 === 0) await yieldToMain()
    }
    return { truncated }
  },
}

function parseCodexRecord(
  source: string,
  line: string,
  context: CodexContext,
  fallbackTime: number
): UsageEvent | null {
  const root = parseObject(line)
  const payload = objectValue(root?.payload)
  if (!root || !payload) return null
  const type = stringValue(root.type)
  if (type === "session_meta") {
    context.session = stringValue(payload.id) ?? context.session
    context.cwd = stringValue(payload.cwd) ?? context.cwd
    return null
  }
  if (type === "turn_context") {
    context.cwd = stringValue(payload.cwd) ?? context.cwd
    context.model = codexModel(payload) ?? context.model
    return null
  }
  if (type !== "event_msg" || stringValue(payload.type) !== "token_count")
    return null
  const info = objectValue(payload.info)
  if (!info) return null
  const total = rawCodexUsage(info.total_token_usage)
  const last = rawCodexUsage(info.last_token_usage)
  const delta = codexDelta(total, last, context)
  if (!delta || rawCodexTotal(delta) === 0) return null

  const timestamp = validTimestamp(root.timestamp, fallbackTime)
  const model = codexModel(payload) ?? context.model
  const cacheRead = Math.min(delta.cacheRead, delta.input)
  const cacheWrite = Math.min(delta.cacheWrite, Math.max(delta.input - cacheRead, 0))
  const counts: UsageTokenCounts = {
    input: Math.max(delta.input - cacheRead - cacheWrite, 0),
    output: delta.output,
    cacheRead,
    cacheWrite,
  }
  return {
    ...counts,
    key: `${source}:${timestamp}:${rawCodexTuple(total)}:${rawCodexTuple(last)}`,
    source,
    session: context.session,
    timestamp,
    model,
    cwd: context.cwd,
  }
}

function codexDelta(
  total: RawCodexUsage | null,
  last: RawCodexUsage | null,
  context: CodexContext
): RawCodexUsage | null {
  const previous = context.previous
  if (context.partial) {
    context.partial = false
    if (total && !last && !previous) {
      context.previous = total
      return null
    }
  }
  if (total && previous && rawCodexEqual(total, previous)) return null
  if (total && last && previous && !rawCodexMonotonic(total, previous)) {
    const previousSize = rawCodexTotal(previous)
    const currentSize = rawCodexTotal(total)
    const lastSize = rawCodexTotal(last)
    if (
      previousSize > 0 &&
      currentSize > 0 &&
      (currentSize * 100 >= previousSize * 98 ||
        currentSize + lastSize * 2 >= previousSize)
    )
      return null
  }
  if (total && last) {
    context.previous = total
    return last
  }
  if (total && previous) {
    context.previous = total
    if (!rawCodexMonotonic(total, previous)) return null
    return subtractCodex(total, previous)
  }
  if (total) {
    context.previous = total
    return total
  }
  if (last) {
    context.previous = previous ? addCodex(previous, last) : null
    return last
  }
  return null
}

function rawCodexUsage(value: JsonValue | undefined): RawCodexUsage | null {
  const usage = objectValue(value)
  if (!usage) return null
  return {
    input: tokenValue(usage.input_tokens),
    output: tokenValue(usage.output_tokens),
    cacheRead: tokenValue(
      usage.cached_input_tokens ?? usage.cache_read_input_tokens
    ),
    cacheWrite: tokenValue(usage.cache_write_input_tokens),
  }
}

function codexModel(payload: JsonObject): string | undefined {
  const direct = stringValue(payload.model) ?? stringValue(payload.model_name)
  if (direct) return direct
  const info = objectValue(payload.info)
  const metadata = objectValue(info?.metadata) ?? objectValue(payload.metadata)
  return (
    stringValue(info?.model) ??
    stringValue(info?.model_name) ??
    stringValue(metadata?.model)
  )
}

function rawCodexEqual(left: RawCodexUsage, right: RawCodexUsage): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite
  )
}

function rawCodexMonotonic(left: RawCodexUsage, right: RawCodexUsage): boolean {
  return (
    left.input >= right.input &&
    left.output >= right.output &&
    left.cacheRead >= right.cacheRead &&
    left.cacheWrite >= right.cacheWrite
  )
}

function subtractCodex(
  left: RawCodexUsage,
  right: RawCodexUsage
): RawCodexUsage {
  return {
    input: Math.max(left.input - right.input, 0),
    output: Math.max(left.output - right.output, 0),
    cacheRead: Math.max(left.cacheRead - right.cacheRead, 0),
    cacheWrite: Math.max(left.cacheWrite - right.cacheWrite, 0),
  }
}

function addCodex(left: RawCodexUsage, right: RawCodexUsage): RawCodexUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  }
}

function rawCodexTotal(usage: RawCodexUsage): number {
  return usage.input + usage.output
}

function rawCodexTuple(usage: RawCodexUsage | null): string {
  return usage
    ? `${usage.input},${usage.output},${usage.cacheRead},${usage.cacheWrite}`
    : ""
}

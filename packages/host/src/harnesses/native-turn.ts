import { stat } from "node:fs/promises"
import { readLines } from "@mako/sessions/jsonl"
import type { ProviderBinding } from "../contracts/conversation-control.js"
import { nativeCheckpoint } from "./native-continuation.js"
import type { z } from "zod"

/** Read only after the native ownership probe proved no other executor holds the session. */
export interface NativeTurnTarget {
  binding: ProviderBinding
  runId: string
}

/** A saved answer, idle process or a different turn is never completion evidence for this turn. */
export type NativeTurnOutcome =
  | { kind: "completed" }
  | { kind: "unfinished" }
  | { kind: "unknown"; reason: string }
  | { kind: "unavailable"; reason: string }

export type NativeTurnReader = (target: NativeTurnTarget) => Promise<NativeTurnOutcome>

/** A bounded completion scan is optional; a changed/unreadable source still needs re-verification. */
export async function readTurnFile<T>(path: string, schema: z.ZodType<T>, consume: (record: T) => void): Promise<"read" | "unknown" | "unavailable"> {
  try {
    const before = await nativeCheckpoint(path)
    const info = await stat(path)
    if (!before || !info.isFile()) return "unavailable"
    if (info.size > 32 * 1024 * 1024) return "unknown"
    let valid = true
    const consumed = await readLines(path, 0, (line) => {
      if (!line.trim()) return
      try {
        const parsed = schema.safeParse(JSON.parse(line))
        if (parsed.success) consume(parsed.data)
        else valid = false
      } catch { valid = false }
    })
    if (before !== await nativeCheckpoint(path)) return "unavailable"
    return valid && consumed === info.size ? "read" : "unknown"
  } catch { return "unavailable" }
}

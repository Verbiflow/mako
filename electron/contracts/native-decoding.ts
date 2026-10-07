import type { Compaction, TranscriptEvent } from "@mako/sessions/events"
import type { UsageWindow } from "../account-types.js"
import type { JsonValue } from "../codex-app-json.js"
import type { LiveUpdate } from "@mako/sessions/live-content"
import type { NativeActivityObservation, NativeNotice } from "./native-activity.js"
import type { LiveSessionState } from "./providers-acp.js"

/**
 * What a harness's decoder makes of one native message, in the vocabulary
 * every harness shares. A decoder is pure: it reads messages and its own
 * assembly state, never a process, a clock or the host, so the same
 * recorded messages always decode the same way.
 *
 * - `update`: transcript content.
 * - `state`: the session's running state (status, error, usage, title).
 * - `activity`: what a running turn is doing without output; `null` ends it.
 * - `marker`, `compacted`: transcript markers. `source` is the native record
 *   the marker stands for, so a replayed record is drawn once.
 * - `usage`: plan-limit windows the account just reported.
 * - `unknown`: a message the decoder has no meaning for, kept with its raw
 *   record. `unreadable` is a kind it knows sent in a shape it can't read.
 * - `effect`: a fact only this harness's driver acts on (a turn id it needs
 *   to interrupt, a server request that closed).
 *
 * An empty list is a message the decoder knows and deliberately shows nothing for.
 */
export type Decoded<Effect = never> =
  | { kind: "update"; update: LiveUpdate }
  | { kind: "state"; patch: Partial<LiveSessionState> }
  | { kind: "activity"; activity: NativeActivityObservation | null }
  | { kind: "marker"; marker: TranscriptEvent; source?: string }
  | { kind: "compacted"; compaction?: Compaction; source?: string }
  | { kind: "usage"; windows: UsageWindow[] }
  | { kind: "unknown"; type: string; reason: "unknown" | "unreadable"; raw: JsonValue }
  | { kind: "effect"; effect: Effect }

/** Where decoded events go; a driver's engine, a replay buffer, or a test's record. */
export interface DecodedSink<Effect = never> {
  updates(updates: LiveUpdate[]): void
  patch(patch: Partial<LiveSessionState>): void
  activity(activity: NativeActivityObservation | null): void
  marker(marker: TranscriptEvent, source?: string): void
  compacted(compaction?: Compaction, source?: string): void
  usage(windows: UsageWindow[]): void
  unknown(type: string, reason: "unknown" | "unreadable", raw: JsonValue): void
  effect(effect: Effect): void
}

/**
 * Hands decoded events to a sink in order. Consecutive content updates go
 * as one batch and consecutive state patches as one patch, so a burst of
 * stream deltas reaches the renderer as one report instead of one each.
 */
export function deliverDecoded<Effect>(decoded: readonly Decoded<Effect>[], sink: DecodedSink<Effect>): void {
  let updates: LiveUpdate[] = []
  let patch: Partial<LiveSessionState> | undefined
  const flush = () => {
    if (updates.length) sink.updates(updates)
    if (patch) sink.patch(patch)
    updates = []
    patch = undefined
  }
  for (const item of decoded) {
    if (item.kind === "update") {
      if (patch) flush()
      updates.push(item.update)
      continue
    }
    if (item.kind === "state") {
      if (updates.length) flush()
      patch = patch ? { ...patch, ...item.patch } : item.patch
      continue
    }
    flush()
    switch (item.kind) {
      case "activity":
        sink.activity(item.activity)
        break
      case "marker":
        sink.marker(item.marker, item.source)
        break
      case "compacted":
        sink.compacted(item.compaction, item.source)
        break
      case "usage":
        sink.usage(item.windows)
        break
      case "unknown":
        sink.unknown(item.type, item.reason, item.raw)
        break
      case "effect":
        sink.effect(item.effect)
        break
    }
  }
  flush()
}

/**
 * A harness's notices about one native record as decoded events. The record's
 * id names its markers, the second and later as `<id>:2`, `<id>:3`, so the
 * same record replayed draws each once.
 */
export function decodedNotices(notices: readonly NativeNotice[], source?: string): Decoded<never>[] {
  let markers = 0
  const id = () => (source ? (markers++ === 0 ? source : `${source}:${markers}`) : undefined)
  return notices.map((notice) =>
    notice.kind === "activity" ? decoded.activity(notice.activity)
      : notice.kind === "compacted" ? decoded.compacted(notice.compaction, id())
        : decoded.marker(notice.event, id()))
}

/** Builders that keep decoders terse. */
export const decoded = {
  update: (update: LiveUpdate): Decoded<never> => ({ kind: "update", update }),
  state: (patch: Partial<LiveSessionState>): Decoded<never> => ({ kind: "state", patch }),
  activity: (activity: NativeActivityObservation | null): Decoded<never> => ({ kind: "activity", activity }),
  marker: (marker: TranscriptEvent, source?: string): Decoded<never> =>
    source === undefined ? { kind: "marker", marker } : { kind: "marker", marker, source },
  compacted: (compaction?: Compaction, source?: string): Decoded<never> => {
    const item: Decoded<never> = { kind: "compacted" }
    if (compaction) item.compaction = compaction
    if (source !== undefined) item.source = source
    return item
  },
  usage: (windows: UsageWindow[]): Decoded<never> => ({ kind: "usage", windows }),
  unknown: (type: string, raw: JsonValue, reason: "unknown" | "unreadable" = "unknown"): Decoded<never> =>
    ({ kind: "unknown", type, reason, raw }),
  effect: <Effect>(effect: Effect): Decoded<Effect> => ({ kind: "effect", effect }),
}

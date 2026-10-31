import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import type { SettingValue } from "@mako/sessions/settings"
import { createHook, createStore } from "@/state/store"

/** One answer given from the dock, kept as a line at the end of the turn it was given in. */
export interface AnsweredRecord {
  id: string
  exchange: string
  kind: "allowed" | "refused" | "answered"
  words: string
  detail?: string
}

/** The answers given from the dock, by conversation: drawn by `LiveSession` through the transcript's `ExchangeNoteContext`. */
export const answeredStore = createStore({ records: new Map<string, readonly AnsweredRecord[]>() })
export const useAnswered = createHook(answeredStore)

export function record(conversation: string, entry: AnsweredRecord): void {
  const records = new Map(answeredStore.get().records)
  records.set(conversation, [...(records.get(conversation) ?? []).filter((each) => each.id !== entry.id), entry])
  answeredStore.set({ records })
}

/** A switch's words: "Switched to GPT-5.5", or, refused, "Not switched to Full access". */
export function switchedWords({ what, refused }: { what: string; refused: boolean }): string {
  return refused ? `Not switched to ${what}` : `Switched to ${what}`
}

/** One thing a message ran with that the one before it didn't: its model, an option's value (its effort), its access. */
export type RecordedSwitch =
  | { kind: "model"; model: string }
  | { kind: "option"; option: string; value: SettingValue }
  | { kind: "mode"; mode: string }

/** A request whose turn was sent: what it ran with is settled. */
const SENT = new Set<LiveRequest["status"]>(["dispatching", "completed", "failed", "uncertain", "interrupted"])

/**
 * Where the model, an option or the access changed between turns, read from the Session's own record: each sent
 * request keeps the settings it went with (`tuning`) and the access its turn ran under (`mode`). Keyed by the request
 * sent before the change, whose turn's end is where its line goes: the turn the switch was made after. Drawn from the
 * record alone, a reload, another device and the live screen all say the same; a fact a request doesn't keep (an older
 * journal's access) is compared with nothing and draws nothing.
 */
export function recordedSwitches(requests: readonly Pick<LiveRequest, "id" | "status" | "tuning" | "mode">[]): Map<string, RecordedSwitch[]> {
  const switches = new Map<string, RecordedSwitch[]>()
  let model: string | undefined
  let mode: string | undefined
  const options = new Map<string, SettingValue>()
  let previous: string | undefined
  for (const request of requests) {
    if (!SENT.has(request.status)) continue
    const changed: RecordedSwitch[] = []
    const next = request.tuning
    if (next?.model) {
      if (model !== undefined && next.model !== model) changed.push({ kind: "model", model: next.model })
      model = next.model
    }
    for (const [option, value] of Object.entries(next?.options ?? {})) {
      const before = options.get(option)
      if (before !== undefined && before !== value) changed.push({ kind: "option", option, value })
      options.set(option, value)
    }
    if (request.mode) {
      if (mode !== undefined && request.mode !== mode) changed.push({ kind: "mode", mode: request.mode })
      mode = request.mode
    }
    if (changed.length && previous) switches.set(previous, changed)
    previous = request.id
  }
  return switches
}

const NO_SWITCHES = new Map<string, RecordedSwitch[]>()
const read = new WeakMap<readonly unknown[], Map<string, RecordedSwitch[]>>()

/** `recordedSwitches` of a conversation's requests, read once per list: a store's selector asks it on every batch. */
export function switchesOf(requests: readonly Pick<LiveRequest, "id" | "status" | "tuning" | "mode">[] | undefined): Map<string, RecordedSwitch[]> {
  if (!requests) return NO_SWITCHES
  let found = read.get(requests)
  if (!found) {
    found = recordedSwitches(requests)
    read.set(requests, found)
  }
  return found
}

/** Whether two readings say the same switches, in the same places. */
export function sameSwitches(left: ReadonlyMap<string, readonly RecordedSwitch[]>, right: ReadonlyMap<string, readonly RecordedSwitch[]>): boolean {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const [request, switches] of left) {
    const other = right.get(request)
    if (!other || JSON.stringify(other) !== JSON.stringify(switches)) return false
  }
  return true
}

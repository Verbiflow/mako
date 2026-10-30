import { createHook, createStore } from "@/state/store"

/**
 * One answer given from the dock, or a model or access switch made from the composer, kept as a line at the end of the
 * turn it was made in.
 */
export interface AnsweredRecord {
  id: string
  exchange: string
  kind: "allowed" | "refused" | "answered" | "switched" | "not-switched"
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

/** A switch's line: "Switched to GPT-5.5", or, refused, "Not switched to Full access". */
export function switchedWords({ what, refused }: { what: string; refused: boolean }): string {
  return refused ? `Not switched to ${what}` : `Switched to ${what}`
}

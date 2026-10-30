import { createHook, createStore } from "@/state/store"

/** One answer given from the dock, kept as a line at the end of the turn it was asked in. */
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

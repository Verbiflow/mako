import type { SharedStore, StoreStandingRow } from "@mako/host/contracts/store-formats"

/**
 * One line for a shared store a newer Mako changed: which Mako, what this
 * one still does with it, and what updating gives back. Nothing is said of
 * a store this build writes as it always has.
 */

interface StoreWords {
  /** What the store holds, as the sentence names it. */
  noun: string
  /** What this build still does with it while it only reads it. */
  reads: string
  /** What updating gives back. */
  update: string
  /** Whether the noun is one thing or several, for the line about a store this build can't read. */
  plural: boolean
}

const WORDS = {
  threads: { noun: "your Threads", reads: "can show them but not change them", update: "Update Mako to edit.", plural: true },
  "session-memory": { noun: "how Mako keeps track of sessions", reads: "can show your sessions but can't resume them", update: "Update Mako to resume them.", plural: false },
  records: { noun: "your session records", reads: "can read and restore them but not take new ones", update: "Update Mako to keep taking them.", plural: true },
  outputs: { noun: "the kept command output", reads: "can show it but not keep new output", update: "Update Mako to keep it.", plural: false },
  archive: { noun: "Mako's copies of sessions", reads: "can show them but not change them", update: "Update Mako to change them.", plural: true },
} satisfies Record<SharedStore, StoreWords>

const DEVELOPMENT = "+development"

/** The build that changed a store, by its stamp: "a newer Mako (0.163.0)", or a development build. */
export function newerMako(stamp: string | undefined): string {
  if (!stamp) return "a newer Mako"
  if (stamp.endsWith(DEVELOPMENT)) return `a development build of Mako (${stamp.slice(0, -DEVELOPMENT.length)})`
  return `a newer Mako (${stamp})`
}

/** The Mako a store needs, by the stamp of the build that raised what it takes to read it. */
export function makoNeeded(stamp: string | undefined): string {
  if (!stamp) return "a newer Mako"
  if (stamp.endsWith(DEVELOPMENT)) return `a development build of Mako (${stamp.slice(0, -DEVELOPMENT.length)}) or later`
  return `Mako ${stamp} or later`
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * "A newer Mako (0.163.0) updated your Threads; this one can show them but
 * not change them. Update Mako to edit." Null for a store this build writes.
 */
export function storeLine(row: StoreStandingRow): string | null {
  const words = WORDS[row.store]
  if (row.access === "read") return `${capitalized(newerMako(row.writtenBy))} updated ${words.noun}; this one ${words.reads}. ${words.update}`
  const [need, them, are] = words.plural ? ["need", "them", "they are"] : ["needs", "it", "it is"]
  if (row.access === "refused") return `${capitalized(words.noun)} ${need} ${makoNeeded(row.readableFrom)}, so this one leaves ${them} as ${are}. Update Mako to open ${them}.`
  return null
}

/** The stores this build only reads or can't read, in the order Diagnostics lists them. */
export function changedStores(stores: readonly StoreStandingRow[]): StoreStandingRow[] {
  return stores.filter((row) => row.access !== "write")
}

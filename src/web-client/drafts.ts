import { z } from "zod"

/**
 * What the person was writing, kept on this browser by place: each Thread's Session (`threadDraftKey`) and each place a
 * new Thread starts in (`newDraftKey`). It outlives a switch to another Thread, the page put away and a reload, and is
 * let go only when a message from it is confirmed sent. A message on its way is kept apart from the words being written
 * (`sending`), so a page closed before its answer finds it again rather than losing it, and the field stays free for the
 * next message meanwhile.
 *
 * In `localStorage`, one entry per place, read and written whole: a draft is a few kilobytes at most, every write is
 * synchronous, and a page about to be killed by the system still keeps what was written before it went.
 */

const PREFIX = "mako:web:draft:"
/** A draft nobody came back to in this long is let go the next time drafts are read. */
const KEPT_MS = 30 * 24 * 60 * 60_000

const DraftSchema = z.object({
  text: z.string(),
  at: z.number(),
  /** Messages sent from here and not yet confirmed, by their request ID: put back if the page goes before they are. */
  sending: z.record(z.string(), z.string()).optional(),
})
export type Draft = z.infer<typeof DraftSchema>

/** The draft of one Session's composer, for one account. */
export function threadDraftKey(account: string, conversation: string): string {
  return `${PREFIX}${account}:c:${conversation}`
}

/** The draft of a new Thread's composer, for one account and place ("cloud", a Mac's project, a Thread being added to). */
export function newDraftKey(account: string, target: string): string {
  return `${PREFIX}${account}:new:${target}`
}

export function readDraft(key: string, now = Date.now()): Draft | undefined {
  try {
    const text = localStorage.getItem(key)
    if (!text) return undefined
    const draft = DraftSchema.safeParse(JSON.parse(text)).data
    if (!draft || now - draft.at > KEPT_MS) {
      localStorage.removeItem(key)
      return undefined
    }
    return draft
  } catch {
    return undefined
  }
}

function write(key: string, draft: Draft): void {
  try {
    if (!draft.text && !Object.keys(draft.sending ?? {}).length) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(draft))
  } catch {
    // Storage full or refused (a private window): the words stay in the field, only not past this page.
  }
}

/** Keeps the words being written; an empty field keeps only what is still on its way. */
export function writeDraft(key: string, text: string, now = Date.now()): void {
  const kept = readDraft(key, now)
  write(key, { text, at: now, ...(kept?.sending && { sending: kept.sending }) })
}

/** A message leaves the field: kept as on its way until `settleSending` says how it went. */
export function noteSending(key: string, requestId: string, text: string, now = Date.now()): void {
  const kept = readDraft(key, now)
  write(key, { text: kept?.text ?? "", at: now, sending: { ...kept?.sending, [requestId]: text } })
}

/** A message confirmed sent, or handed back to the field: no longer kept as on its way. */
export function settleSending(key: string, requestId: string, now = Date.now()): void {
  const kept = readDraft(key, now)
  if (!kept?.sending?.[requestId]) return
  const sending = Object.fromEntries(Object.entries(kept.sending).filter(([id]) => id !== requestId))
  write(key, { text: kept.text, at: now, ...(Object.keys(sending).length && { sending }) })
}

/**
 * The words a composer opens with. A message left on its way by a page that went is put back, unless the outbox still
 * holds it under its ID (`stillOwned`): then it is sent again from there, under that ID, and the field stays as it was.
 * Put-back words go after anything written since, never over it.
 */
export function openingText(key: string, stillOwned: (requestId: string) => boolean, now = Date.now()): string {
  const kept = readDraft(key, now)
  if (!kept) return ""
  const orphans = Object.entries(kept.sending ?? {}).filter(([id]) => !stillOwned(id))
  if (!orphans.length) return kept.text
  const text = [kept.text, ...orphans.map(([, words]) => words)].filter((each) => each.trim()).join("\n\n")
  const sending = Object.fromEntries(Object.entries(kept.sending ?? {}).filter(([id]) => stillOwned(id)))
  write(key, { text, at: now, ...(Object.keys(sending).length && { sending }) })
  return text
}

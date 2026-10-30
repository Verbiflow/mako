import { useEffect, useMemo } from "react"
import { z } from "zod"
import { CommentDetailSchema, type CommentDetail } from "@/lib/context-detail"
import { writeDraft } from "@/lib/context/draft"
import { attachmentReference } from "@/lib/attachment-references"
import type { Attachment } from "@/lib/attachments"
import { commentLabel } from "@/lib/line-comments"
import { createHook, createStore } from "@/state/store"

/*
 * The phone's comments on a turn's lines, waiting in one Session's draft.
 * Each is the desk's own "comment on lines" (`CommentDetail`, the chip a
 * diff comment makes on a Mac), so it reaches the agent in Mako's context
 * format, as an item of the message with the lines it's about. None is ever
 * sent by itself: they ride with the next message sent to the Session, or
 * go together when the review is finished. Kept on this browser by Session,
 * as drafts are (`drafts.ts`), and let go once the message carrying them is
 * taken. While a message carries them they're marked with its request ID and
 * out of the draft, so a page killed mid-send never sends them again with
 * the next message: after a reload they leave with that message, which the
 * outbox asks again for, or come back if it's gone (`resumeReviewNotes`).
 */

export interface ReviewNote {
  id: string
  detail: CommentDetail
  /** When it was written (epoch milliseconds). */
  at: number
  /** The request ID of the message carrying it, while that message is on its way. */
  sending?: string
}

const NoteSchema = z.object({ id: z.string(), detail: CommentDetailSchema, at: z.number(), sending: z.string().optional() })
const PREFIX = "mako:web:review:"
/** Comments nobody sent in this long are let go the next time they're read. */
const KEPT_MS = 30 * 24 * 60 * 60_000

const NO_NOTES: readonly ReviewNote[] = []
const notesStore = createStore<{ byConversation: Readonly<Record<string, readonly ReviewNote[]>> }>({ byConversation: {} })
const useNotesState = createHook(notesStore)

/** What this browser kept for the Session, read without holding it. */
function peek(conversation: string): readonly ReviewNote[] {
  try {
    const text = localStorage.getItem(PREFIX + conversation)
    const parsed = text ? z.array(NoteSchema).safeParse(JSON.parse(text)).data : undefined
    return parsed ? parsed.filter((note) => Date.now() - note.at < KEPT_MS) : NO_NOTES
  } catch {
    // Storage refused (a private window): this page's notes only.
    return NO_NOTES
  }
}

/** Every note kept for the Session, waiting or on its way. */
function read(conversation: string): readonly ReviewNote[] {
  const held = notesStore.get().byConversation[conversation]
  if (held) return held
  const found = peek(conversation)
  notesStore.set((state) => ({ byConversation: { ...state.byConversation, [conversation]: found } }))
  return found
}

function write(conversation: string, notes: readonly ReviewNote[]): void {
  notesStore.set((state) => ({ byConversation: { ...state.byConversation, [conversation]: notes } }))
  try {
    if (notes.length) localStorage.setItem(PREFIX + conversation, JSON.stringify(notes))
    else localStorage.removeItem(PREFIX + conversation)
  } catch {
    // Kept for this page only.
  }
}

const waitingIn = (notes: readonly ReviewNote[]) => (notes.some((note) => note.sending) ? notes.filter((note) => !note.sending) : notes)

/** The Session's waiting comments, in the order they were written: those a message carries now aren't. */
export function useReviewNotes(conversation: string): readonly ReviewNote[] {
  const notes = useNotesState((state) => state.byConversation[conversation])
  useEffect(() => void read(conversation), [conversation])
  const all = notes ?? peek(conversation)
  return useMemo(() => waitingIn(all), [all])
}

export function reviewNotes(conversation: string): readonly ReviewNote[] {
  return waitingIn(read(conversation))
}

export function addReviewNotes(conversation: string, details: readonly CommentDetail[]): void {
  const at = Date.now()
  write(conversation, [...read(conversation), ...details.map((detail) => ({ id: crypto.randomUUID(), detail, at }))])
}

export function dropReviewNote(conversation: string, id: string): void {
  write(conversation, read(conversation).filter((note) => note.id !== id))
}

/** The waiting comments, given to the message `request`: marked with it, kept, and out of the draft while it goes. */
export function takeReviewNotes(conversation: string, request: string): readonly ReviewNote[] {
  const taken = reviewNotes(conversation)
  if (taken.length) write(conversation, read(conversation).map((note) => (note.sending ? note : { ...note, sending: request })))
  return taken
}

/** The message `request` was taken: the comments it carried are let go. Any written meanwhile stay. */
export function settleReviewNotes(conversation: string, request: string): void {
  const all = read(conversation)
  if (all.some((note) => note.sending === request)) write(conversation, all.filter((note) => note.sending !== request))
}

/** The message `request` didn't go: the comments it carried wait in the draft again. */
export function returnReviewNotes(conversation: string, request: string): void {
  const all = read(conversation)
  if (all.some((note) => note.sending === request)) write(conversation, all.map((note) => (note.sending === request ? { id: note.id, detail: note.detail, at: note.at } : note)))
}

/**
 * After a reload, the comments a message carried when the page went: gone with it if the host has it (`taken`), still
 * on their way if the outbox will ask for it again (`asking`), and back in the draft otherwise.
 */
export function resumeReviewNotes(conversation: string, taken: (request: string) => boolean, asking: (request: string) => boolean): void {
  const requests = new Set(read(conversation).flatMap((note) => (note.sending ? [note.sending] : [])))
  for (const request of requests) {
    if (taken(request)) settleReviewNotes(conversation, request)
    else if (!asking(request)) returnReviewNotes(conversation, request)
  }
}

/**
 * Sends `words` with the comments waiting in the Session's draft as the message `request`, through `send`: the
 * comments go with it (`takeReviewNotes`), leave once `send` says it was taken, and wait again when it was refused or
 * failed. One written while the message was on its way waits for the next.
 */
export async function sendWithReviewNotes(conversation: string, request: string, words: string, send: (text: string) => Promise<boolean>): Promise<boolean> {
  const notes = takeReviewNotes(conversation, request)
  let went = false
  try {
    went = await send(withReviewNotes(words, notes))
    return went
  } finally {
    if (went) settleReviewNotes(conversation, request)
    else returnReviewNotes(conversation, request)
  }
}

/** A comment as the chip the transcript shows: `app.ts:12–18`. */
export function noteLabel(note: ReviewNote): string {
  return commentLabel(note.detail)
}

/**
 * The words with the comments after them, as the desk writes a message with
 * its chips (`writeDraft`): each comment a marker in the words and an item of
 * the message's context. With no comments, the words as they are.
 */
export function withReviewNotes(words: string, notes: readonly ReviewNote[]): string {
  if (!notes.length) return words
  const records: Attachment[] = notes.map((note, index) => ({
    id: note.id,
    index: index + 1,
    name: noteLabel(note),
    contextLabel: noteLabel(note),
    mimeType: "text/plain",
    kind: "text",
    detail: note.detail,
  }))
  const anchors = records.map((record) => attachmentReference(record)).join(" ")
  return writeDraft({ draft: words.trim() ? `${words.trimEnd()}\n\n${anchors}` : anchors, records }).text
}

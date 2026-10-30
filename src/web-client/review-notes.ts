import { useEffect } from "react"
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
 * taken.
 */

export interface ReviewNote {
  id: string
  detail: CommentDetail
  /** When it was written (epoch milliseconds). */
  at: number
}

const NoteSchema = z.object({ id: z.string(), detail: CommentDetailSchema, at: z.number() })
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

/** The Session's waiting comments, in the order they were written. */
export function useReviewNotes(conversation: string): readonly ReviewNote[] {
  const notes = useNotesState((state) => state.byConversation[conversation])
  useEffect(() => void read(conversation), [conversation])
  return notes ?? peek(conversation)
}

export function reviewNotes(conversation: string): readonly ReviewNote[] {
  return read(conversation)
}

export function addReviewNotes(conversation: string, details: readonly CommentDetail[]): void {
  const at = Date.now()
  write(conversation, [...read(conversation), ...details.map((detail) => ({ id: crypto.randomUUID(), detail, at }))])
}

export function dropReviewNote(conversation: string, id: string): void {
  write(conversation, read(conversation).filter((note) => note.id !== id))
}

/** Lets go of the comments a message carried, once it was taken; any written meanwhile stay. */
export function settleReviewNotes(conversation: string, sent: readonly ReviewNote[]): void {
  const gone = new Set(sent.map((note) => note.id))
  write(conversation, read(conversation).filter((note) => !gone.has(note.id)))
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

import { getMako } from "@/lib/bridge"
import {
  parseThreadToken,
  tokenize,
} from "@/lib/mentions"
import type { ThreadRef } from "@/lib/types"
import { threadLabel } from "@/lib/draft-view"
import {
  findThreadReference,
  locateTokens,
  prepareThreadTokens,
  type ConversationContext,
  type PreparedThreadReference,
  type ThreadTokenUse,
} from "@mako/sessions/thread-references"

export { findThreadReference, type PreparedThreadReference }

/**
 * One heading of a sent prompt's appendix, read back. `token` is the
 * conversation the placeholder stood for and is what lets the transcript
 * draw the chip again and a reused prompt reference again; a prompt sent
 * before headings carried it has only the title and harness to show.
 */
export interface ThreadAppendixEntry {
  number: number
  title: string
  harness?: string
  token?: { harness: string; id: string }
}

export interface ParsedThreadAppendix {
  /** The prompt without its appendix, placeholders still in place. */
  body: string
  references: ThreadAppendixEntry[]
}

const RULE = "\n---\n"
const APPENDIX_MARK = `${RULE}[Referenced conversation `
const HEADING = /^\[Referenced conversation (\d+)\] (.*)$/gm
const TOKEN_TRAILER = / — (@thread:\S+)$/
const HARNESS_TRAILER = / \(([^()\s]+)\)$/


const pending = new Map<string, Promise<ConversationContext | null>>()
const remembered = new Map<string, ThreadRef>()

function tokenKey(harness: string, id: string): string {
  return `${harness}\0${id}`
}

function threadTokens(text: string): ThreadTokenUse[] {
  return tokenize(text).flatMap((segment) => (segment.kind === "thread" ? [segment] : []))
}

/** Neither a token nor a label holds it: tokens are URI-encoded and labels flatten whitespace. */
const LABEL_SEPARATOR = "\u0000"

/**
 * The composer's label for each conversation token in `text`, as token and
 * label pairs in one string, so a selector over the catalog changes only when
 * a label does. `findThreadReference` decides, as it does for the send.
 */
export function threadLabelKey(text: string, threads: ThreadRef[], loaded = true): string {
  const pairs = new Map<string, string>()
  for (const segment of tokenize(text)) {
    if (segment.kind !== "thread" || pairs.has(segment.raw)) continue
    const thread = findThreadReference(threads, segment.harness, segment.id)
    // Until the catalog has loaded, a restored draft's conversation is a chip
    // without its title, not 50 characters of id; once it has, a token that
    // names nothing shows as typed.
    if (thread) pairs.set(segment.raw, threadLabel(thread.title).replaceAll(LABEL_SEPARATOR, ""))
    else if (!loaded) pairs.set(segment.raw, "@Conversation")
  }
  return [...pairs].flat().join(LABEL_SEPARATOR)
}

export function threadLabelMap(key: string): ReadonlyMap<string, string> {
  const parts = key ? key.split(LABEL_SEPARATOR) : []
  const labels = new Map<string, string>()
  for (let index = 0; index + 1 < parts.length; index += 2) labels.set(parts[index]!, parts[index + 1]!)
  return labels
}

/**
 * Remembering a prior resolution lets a draft survive a catalog refresh or
 * deletion between selection and send.
 */
function resolveThread(
  harness: string,
  id: string,
  threads: ThreadRef[]
): ThreadRef | undefined {
  const key = tokenKey(harness, id)
  const found = findThreadReference(threads, harness, id)
  if (found) {
    remembered.set(key, found)
    return found
  }
  return remembered.get(key)
}

/**
 * Read a sent prompt's appendix back into what each placeholder meant. The
 * body keeps its placeholders; `restoreThreadReferences` puts the tokens
 * back where they are known. Headings must count up from one: an earlier
 * build sent a whole transcript inline, which may itself quote a heading,
 * and a number out of sequence is that quote, not a reference.
 */
export function parseThreadReferenceAppendix(text: string): ParsedThreadAppendix {
  const at = text.lastIndexOf(APPENDIX_MARK)
  if (at === -1) return { body: text, references: [] }
  const references: ThreadAppendixEntry[] = []
  for (const match of text.slice(at + RULE.length).matchAll(HEADING)) {
    if (Number(match[1]) !== references.length + 1) continue
    let rest = match[2]!
    const trailer = TOKEN_TRAILER.exec(rest)
    const token = trailer ? parseThreadToken(trailer[1]!.slice(1)) : null
    if (trailer) rest = rest.slice(0, trailer.index)
    const named = HARNESS_TRAILER.exec(rest)
    // The harness in parentheses is stripped from the title only when it is
    // the harness: with a token that is a known answer, without one (an
    // older prompt) every heading that had a harness wrote it there.
    const harness = token?.harness ?? named?.[1]
    const title =
      named && (!token || named[1] === token.harness)
        ? rest.slice(0, named.index)
        : rest
    const entry: ThreadAppendixEntry = { number: references.length + 1, title }
    if (harness) entry.harness = harness
    if (token) entry.token = token
    references.push(entry)
  }
  return { body: text.slice(0, at).trimEnd(), references }
}

/** Put each known token back where its placeholder stands, so the body reads as it was written. */
function contextVersion(thread: ThreadRef): string {
  return `${thread.bytes ?? "?"}:${thread.updatedAt ?? "?"}`
}

function contextKey(thread: ThreadRef): string {
  return `${thread.path}\0${contextVersion(thread)}`
}

function context(thread: ThreadRef): Promise<ConversationContext | null> {
  const key = contextKey(thread)
  const prefix = `${thread.path}\0`
  for (const cached of pending.keys()) {
    if (cached !== key && cached.startsWith(prefix)) pending.delete(cached)
  }
  const held = pending.get(key)
  if (held) return held
  const request = contextBatch([thread]).then((items) => items[0] ?? null)
  pending.set(key, request)
  return request
}

function contextBatch(threads: ThreadRef[]): Promise<Array<ConversationContext | null>> {
  const unique = [...new Map(threads.map((thread) => [thread.path, thread])).values()]
  const missing = unique.filter(
    (thread) => !pending.has(contextKey(thread))
  )
  if (missing.length > 0) {
    const paths = missing.map((thread) => thread.path)
    const request: Promise<Array<ConversationContext | null>> = getMako().threadContexts(paths)
    for (let index = 0; index < missing.length; index += 1) {
      const thread = missing[index]!
      const key = contextKey(thread)
      pending.set(
        key,
        request
          .then((items) => {
            const item = items[index] ?? null
            if (!item) pending.delete(key)
            return item
          })
          .catch(() => {
            pending.delete(key)
            return null
          })
      )
    }
  }
  return Promise.all(threads.map((thread) => context(thread)))
}

/**
 * What each conversation token in `text` stands for at send, keyed by the
 * token as typed: the row it resolves to (remembered across a catalog
 * refresh), the token to write, and its prepared bundle. Bundles are made
 * in one batch, and a bundle a prefetch started is reused.
 */
export async function prepareThreadReferences(
  text: string,
  threads: ThreadRef[]
): Promise<Map<string, PreparedThreadReference>> {
  return prepareThreadTokens(threadTokens(text), (harness, id) => resolveThread(harness, id, threads), contextBatch)
}

export function prefetchThreadReferences(
  text: string,
  threads: ThreadRef[]
): void {
  const referenced = locateTokens(threadTokens(text), (harness, id) => resolveThread(harness, id, threads)).references.flatMap((reference) =>
    reference.thread ? [reference.thread] : []
  )
  if (referenced.length > 0) void contextBatch(referenced)
}

export function stripThreadReferenceAppendix(text: string): string {
  const at = text.lastIndexOf(APPENDIX_MARK)
  return at === -1 ? text : text.slice(0, at).trimEnd()
}


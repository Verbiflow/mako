import { getMako } from "@/lib/bridge"
import {
  parseThreadToken,
  threadReferenceId,
  threadToken,
  tokenize,
  type Segment,
} from "@/lib/mentions"
import type { ThreadRef } from "@/lib/types"

interface ThreadFileContext {
  kind: "file"
  file: string
  title?: string
  harness: string
}

interface ThreadInlineContext {
  kind: "inline"
  content: string
  title?: string
  harness: string
}

type ThreadContext = ThreadFileContext | ThreadInlineContext

interface LocatedReference {
  key: string
  number: number
  thread?: ThreadRef
  /** The token as typed, for a heading whose conversation did not resolve. */
  raw: string
}

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
const PLACEHOLDER = /\[Referenced conversation (\d+)\]/g
const HEADING = /^\[Referenced conversation (\d+)\] (.*)$/gm
const TOKEN_TRAILER = / — (@thread:\S+)$/
const HARNESS_TRAILER = / \(([^()\s]+)\)$/

function placeholder(number: number): string {
  return `[Referenced conversation ${number}]`
}

interface LocatedSegment {
  segment: Segment
  reference?: LocatedReference
}

interface LocatedReferences {
  segments: LocatedSegment[]
  references: LocatedReference[]
}

export interface ThreadReferenceOptions {
  /** Remote agents receive transcript data inline because local paths are inaccessible. */
  inline?: boolean
}

const pending = new Map<string, Promise<ThreadContext | null>>()
const remembered = new Map<string, ThreadRef>()

function tokenKey(harness: string, id: string): string {
  return `${harness}\0${id}`
}

/**
 * One row out of several that a token could mean. A provider may present one
 * native session as more than one store (Cursor's `chats/` continuation of an
 * ACP session carries `identity: "chats:<id>"`); the store without a derived
 * identity is the original, and a token that names only the shared native id
 * — every token minted before identities existed — means that one. Rows with
 * different native ids are genuinely different conversations and stay
 * ambiguous.
 */
function primary(candidates: ThreadRef[]): ThreadRef | undefined {
  if (candidates.length === 1) return candidates[0]
  if (candidates.length === 0) return undefined
  const nativeId = candidates[0]!.nativeId
  if (!candidates.every((entry) => entry.nativeId === nativeId)) return undefined
  const originals = candidates.filter((entry) => entry.identity === undefined)
  return originals.length === 1 ? originals[0] : undefined
}

/**
 * The catalog row a thread token names, or `undefined` when none does. The
 * token's id is the provider's identity (`threadReferenceId`), so an exact
 * identity match wins; an exact native id is next, for tokens older than the
 * identity field. A legacy shortened id resolves only when its prefix
 * identifies one conversation. Ambiguity is deliberately left unresolved
 * rather than attaching the wrong conversation. The same rule decides what a
 * chip shows and what a send attaches, so the two cannot disagree.
 */
export function findThreadReference(
  threads: ThreadRef[],
  harness: string,
  id: string
): ThreadRef | undefined {
  const own = threads.filter((entry) => entry.harness === harness)
  const byIdentity = own.filter((entry) => threadReferenceId(entry) === id)
  if (byIdentity.length > 0) return primary(byIdentity)
  const byNativeId = own.filter((entry) => entry.nativeId === id)
  if (byNativeId.length > 0) return primary(byNativeId)
  return primary(
    own.filter(
      (entry) =>
        threadReferenceId(entry).startsWith(id) || entry.nativeId.startsWith(id)
    )
  )
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

function locate(text: string, threads: ThreadRef[]): LocatedReferences {
  const references: LocatedReference[] = []
  const byKey = new Map<string, LocatedReference>()
  const segments = tokenize(text).map((segment): LocatedSegment => {
    if (segment.kind !== "thread") return { segment }
    const thread = resolveThread(segment.harness, segment.id, threads)
    const key = thread
      ? `path\0${thread.path}`
      : `token\0${tokenKey(segment.harness, segment.id)}`
    let reference = byKey.get(key)
    if (!reference) {
      reference = { key, number: references.length + 1, thread, raw: segment.raw }
      byKey.set(key, reference)
      references.push(reference)
    }
    return { segment, reference }
  })
  return { segments, references }
}

function replaceTokens(segments: LocatedSegment[]): string {
  return segments
    .map(({ segment, reference }) =>
      segment.kind === "thread" && reference
        ? placeholder(reference.number)
        : segment.kind === "text"
          ? segment.text
          : segment.raw
    )
    .join("")
}

/**
 * The token a heading names: the catalog's own for a conversation that
 * resolved (a shortened id from an old draft comes back whole), else the one
 * typed, so even an unavailable reference reads back as the chip it was.
 */
function headingToken(reference: LocatedReference): string {
  return reference.thread
    ? threadToken(reference.thread.harness, threadReferenceId(reference.thread))
    : reference.raw
}

/**
 * Read a sent prompt's appendix back into what each placeholder meant. The
 * body keeps its placeholders; `restoreThreadReferences` puts the tokens
 * back where they are known. Headings must count up from one: a remote
 * inline bundle carries a whole earlier transcript, which may itself quote a
 * heading, and a number out of sequence is that quote, not a reference.
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
export function restoreThreadReferences(
  body: string,
  references: readonly ThreadAppendixEntry[]
): string {
  if (!references.some((entry) => entry.token)) return body
  return body.replace(PLACEHOLDER, (found, number: string) => {
    const token = references[Number(number) - 1]?.token
    return token ? threadToken(token.harness, token.id) : found
  })
}

function contextVersion(thread: ThreadRef): string {
  return `${thread.bytes ?? "?"}:${thread.updatedAt ?? "?"}`
}

function contextKey(thread: ThreadRef, inline: boolean): string {
  return `${inline ? "inline" : "file"}\0${thread.path}\0${contextVersion(thread)}`
}

function context(
  thread: ThreadRef,
  inline: boolean
): Promise<ThreadContext | null> {
  const key = contextKey(thread, inline)
  const prefix = `${inline ? "inline" : "file"}\0${thread.path}\0`
  for (const cached of pending.keys()) {
    if (cached !== key && cached.startsWith(prefix)) pending.delete(cached)
  }
  const held = pending.get(key)
  if (held) return held
  const request = contextBatch([thread], inline).then((items) => items[0] ?? null)
  pending.set(key, request)
  return request
}

function contextBatch(
  threads: ThreadRef[],
  inline: boolean
): Promise<Array<ThreadContext | null>> {
  const unique = [...new Map(threads.map((thread) => [thread.path, thread])).values()]
  const missing = unique.filter(
    (thread) => !pending.has(contextKey(thread, inline))
  )
  if (missing.length > 0) {
    const paths = missing.map((thread) => thread.path)
    const request: Promise<Array<ThreadContext | null>> = inline
      ? getMako().threadContexts(paths, { inline: true })
      : getMako().threadContexts(paths)
    for (let index = 0; index < missing.length; index += 1) {
      const thread = missing[index]!
      const key = contextKey(thread, inline)
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
  return Promise.all(threads.map((thread) => context(thread, inline)))
}

export function prefetchThreadReferences(
  text: string,
  threads: ThreadRef[]
): void {
  const referenced = locate(text, threads).references.flatMap((reference) =>
    reference.thread ? [reference.thread] : []
  )
  if (referenced.length > 0) void contextBatch(referenced, false)
}

export function stripThreadReferenceAppendix(text: string): string {
  const at = text.lastIndexOf(APPENDIX_MARK)
  return at === -1 ? text : text.slice(0, at).trimEnd()
}

export async function appendThreadReferences(
  text: string,
  threads: ThreadRef[],
  options: ThreadReferenceOptions = {}
): Promise<string> {
  const located = locate(text, threads)
  if (located.references.length === 0) return text

  const replaced = replaceTokens(located.segments)
  const available = located.references.filter(
    (reference): reference is LocatedReference & { thread: ThreadRef } =>
      reference.thread !== undefined
  )
  const prepared = await contextBatch(
    available.map((reference) => reference.thread),
    options.inline === true
  )
  const contextByKey = new Map<string, ThreadContext | null>()
  for (let index = 0; index < available.length; index += 1) {
    contextByKey.set(available[index]!.key, prepared[index] ?? null)
  }

  const lines: string[] = []
  for (const reference of located.references) {
    const preparedContext = contextByKey.get(reference.key)
    const title =
      preparedContext?.title ?? reference.thread?.title ?? "Untitled conversation"
    const harness = preparedContext?.harness ?? reference.thread?.harness
    // The heading ends with the token the placeholder replaced. The model
    // reads the title and the harness; the transcript reads the token, so
    // the prompt shows the chip that was typed and Reuse references again.
    // Without it a sent prompt read "[Referenced conversation 1]" for good.
    lines.push(
      `${placeholder(reference.number)} ${title}${harness ? ` (${harness})` : ""} — ${headingToken(reference)}`
    )
    if (!preparedContext) {
      lines.push(
        "This referenced conversation is unavailable or no longer exists. Do not infer its contents."
      )
    } else if (preparedContext.kind === "inline") {
      lines.push(
        "Remote inline transcript bundle follows. Read its security boundary, chronology, integrity, and loss directions before using the history.",
        "",
        preparedContext.content
      )
    } else {
      lines.push(
        `Local transcript bundle: ${preparedContext.file}`,
        "Before using this reference, read transcript.md at that exact content-addressed path in full.",
        "Read turns NEWEST FIRST while preserving chronological order inside each turn. Read the Bundle integrity section, inspect complete tool input/output sidecars beside the transcript, and respect every declared loss without guessing omitted history."
      )
    }
  }
  return `${replaced.trimEnd()}\n${RULE}${lines.join("\n\n")}`
}

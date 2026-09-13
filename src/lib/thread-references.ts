import { getMako } from "@/lib/bridge"
import { threadReferenceId, tokenize, type Segment } from "@/lib/mentions"
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
      reference = { key, number: references.length + 1, thread }
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
        ? `[Referenced conversation ${reference.number}]`
        : segment.kind === "text"
          ? segment.text
          : segment.raw
    )
    .join("")
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
  const at = text.lastIndexOf("\n---\n[Referenced conversation ")
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
    lines.push(
      `[Referenced conversation ${reference.number}] ${title}${harness ? ` (${harness})` : ""}`
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
  return `${replaced.trimEnd()}\n\n---\n${lines.join("\n\n")}`
}

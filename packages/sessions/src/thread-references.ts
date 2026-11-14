import type { ThreadRef } from "./format.js"
import type { ItemAttributes, WireItem } from "./context-wire.js"

/**
 * What a reference to another conversation is, from its token to its item in
 * a message: one implementation, the composer's chip and an agent's `context`
 * alike (`src/lib/thread-references.ts` in the window, `agents.ts` on the
 * host). Pure, with no Node built-ins. Where a transcript bundle comes from
 * is the caller's: the window asks the host, the host its catalog.
 */

/** What a referenced conversation's item says: its transcript, and the note that hands it to the agent. */
export interface ConversationContext {
  kind: "file"
  file: string
  /** The host's note naming the transcript and how to read it (`transcriptNote`). */
  note: string
  title?: string
  harness: string
}

export interface ConversationItem {
  /** The token's body, `thread:<harness>:<id>`, when the reference was typed as one. */
  ref?: string
  harness?: string
  title: string
}

export interface WrittenItem {
  kind: string
  /** The marker's noun, or null for an item with no place in the words (a skill, a plan). */
  noun: string | null
  label: string
  attrs: ItemAttributes
  body: string
}

/**
 * The id a thread token carries: the provider's dedupe identity when it has
 * one, else the native id. A Cursor session continued by the CLI into
 * `chats/` shares its native id with the original store, so a token minted
 * from the native id alone would name two rows and resolve to neither.
 */
export function threadReferenceId(ref: { nativeId: string; identity?: string }): string {
  return ref.identity ?? ref.nativeId
}

export function threadToken(harness: string, id: string): string {
  // The full id keeps the token collision-safe. Older drafts containing
  // shortened ids still resolve when their prefix identifies exactly one thread.
  return `@thread:${encodeURIComponent(harness)}:${encodeURIComponent(id)}`
}

export function parseThreadToken(body: string): { harness: string; id: string } | null {
  const match = /^thread:([^:]+):(.+)$/.exec(body)
  if (!match) return null
  try {
    return { harness: decodeURIComponent(match[1]!), id: decodeURIComponent(match[2]!) }
  } catch {
    return null
  }
}

/**
 * One row out of several that a token could mean. A provider may present one
 * native session as more than one store (Cursor's `chats/` continuation of an
 * ACP session carries `identity: "chats:<id>"`, and one resumed from another
 * folder `chats:<workspace>:<id>`); the store without a derived identity is
 * the original, or failing that the first chats store, and a token that
 * names only the shared native id — every token minted before identities
 * existed — means that one. Rows with different native ids are genuinely
 * different conversations and stay ambiguous.
 */
function primary(candidates: ThreadRef[]): ThreadRef | undefined {
  if (candidates.length === 1) return candidates[0]
  if (candidates.length === 0) return undefined
  const nativeId = candidates[0]!.nativeId
  if (!candidates.every((entry) => entry.nativeId === nativeId)) return undefined
  const originals = candidates.filter((entry) => entry.identity === undefined)
  if (originals.length > 0) return originals.length === 1 ? originals[0] : undefined
  const first = candidates.filter((entry) => entry.identity === `chats:${nativeId}`)
  return first.length === 1 ? first[0] : undefined
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
  threads: readonly ThreadRef[],
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

/** A conversation token as it was typed: `raw` with its `@`, `harness` and `id` as it reads. */
export interface ThreadTokenUse {
  raw: string
  harness: string
  id: string
}

export interface LocatedReference {
  key: string
  thread?: ThreadRef
  /** The token as typed, for a heading whose conversation did not resolve. */
  raw: string
}

export interface PreparedThreadReference {
  /** The catalog row the token resolved to, when it did. */
  thread?: ThreadRef
  /** The token's body to write, `thread:<harness>:<id>`: the catalog's own for one that resolved. */
  ref: string
  /** The transcript bundle prepared for it, or null when it is unavailable. */
  context: ConversationContext | null
}

type ResolveToken = (harness: string, id: string) => ThreadRef | undefined

export interface LocatedTokens {
  uses: { token: ThreadTokenUse; reference: LocatedReference }[]
  references: LocatedReference[]
}

/** Each token's conversation, and each conversation once however many tokens name it. */
export function locateTokens(tokens: readonly ThreadTokenUse[], resolve: ResolveToken): LocatedTokens {
  const references: LocatedReference[] = []
  const byKey = new Map<string, LocatedReference>()
  const uses = tokens.map((token) => {
    const thread = resolve(token.harness, token.id)
    const key = thread ? `path\0${thread.path}` : `token\0${token.harness}\0${token.id}`
    let reference = byKey.get(key)
    if (!reference) {
      reference = { key, raw: token.raw, ...(thread && { thread }) }
      byKey.set(key, reference)
      references.push(reference)
    }
    return { token, reference }
  })
  return { uses, references }
}

/**
 * The token a heading names: the catalog's own for a conversation that
 * resolved (a shortened id from an old draft comes back whole), else the one
 * typed, so even an unavailable reference reads back as the chip it was.
 */
export function headingToken(reference: LocatedReference): string {
  return reference.thread
    ? threadToken(reference.thread.harness, threadReferenceId(reference.thread))
    : reference.raw
}

/**
 * What each conversation token stands for, keyed by the token as typed: the
 * row it resolves to, the token to write, and its prepared bundle. `contexts`
 * makes the bundles of the conversations that resolved, in one batch.
 */
export async function prepareThreadTokens(
  tokens: readonly ThreadTokenUse[],
  resolve: ResolveToken,
  contexts: (threads: ThreadRef[]) => Promise<readonly (ConversationContext | null)[]>
): Promise<Map<string, PreparedThreadReference>> {
  const { uses, references } = locateTokens(tokens, resolve)
  const available = references.filter((reference) => reference.thread)
  const prepared = await contexts(available.map((reference) => reference.thread!))
  const bundles = new Map(available.map((reference, index) => [reference.key, prepared[index] ?? null]))
  const result = new Map<string, PreparedThreadReference>()
  for (const { token, reference } of uses) {
    if (result.has(token.raw)) continue
    const entry: PreparedThreadReference = { ref: headingToken(reference).slice(1), context: bundles.get(reference.key) ?? null }
    if (reference.thread) entry.thread = reference.thread
    result.set(token.raw, entry)
  }
  return result
}

export function writeConversation(item: ConversationItem, context: ConversationContext | null): WrittenItem {
  const attrs: ItemAttributes = {}
  if (item.ref) attrs.ref = item.ref
  const harness = context?.harness ?? item.harness
  if (harness) attrs.harness = harness
  attrs.title = context?.title ?? item.title
  const body = context ? context.note : "This conversation is unavailable or no longer exists. Do not infer its contents."
  return { kind: "conversation", noun: "Conversation", label: attrs.title, attrs, body }
}

/** A token's item, as a chip writes it and as an agent's `context` does. */
export function writeReference(token: ThreadTokenUse, prepared: PreparedThreadReference | undefined): WrittenItem {
  return writeConversation(
    {
      ref: prepared?.ref ?? token.raw.slice(1),
      harness: prepared?.thread?.harness ?? token.harness,
      title: prepared?.thread?.title ?? "Untitled conversation",
    },
    prepared?.context ?? null
  )
}

/** References with no place in any words, each attached once: an agent's `context`, as `writeMessage` takes them. */
export async function referenceItems(
  refs: readonly string[],
  resolve: ResolveToken,
  contexts: (threads: ThreadRef[]) => Promise<readonly (ConversationContext | null)[]>
): Promise<WireItem[]> {
  const tokens = refs.flatMap((ref): ThreadTokenUse[] => {
    const parsed = parseThreadToken(ref)
    return parsed ? [{ raw: `@${ref}`, ...parsed }] : []
  })
  const prepared = await prepareThreadTokens(tokens, resolve, contexts)
  const seen = new Set<string>()
  const items: WireItem[] = []
  for (const token of tokens) {
    const reference = prepared.get(token.raw)
    const key = reference?.ref ?? token.raw
    if (seen.has(key)) continue
    seen.add(key)
    const written = writeReference(token, reference)
    items.push({ n: items.length + 1, kind: written.kind, attrs: written.attrs, body: written.body })
  }
  return items
}

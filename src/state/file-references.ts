import { useSyncExternalStore } from "react"
import type { FileReferenceSource, FileResolution } from "@mako/host/contracts/file-references"
import { getMako, hasBridge } from "@/lib/bridge"

/**
 * Which file a spelling in an answer means, asked of the host once per
 * transcript per tick however many links render, and kept.
 *
 * `undefined` while first asking; `null` when the host can't say (its
 * journal isn't open, or no desktop), so the link behaves as before,
 * unchecked. A file found is kept a minute; nothing found or a tie, ten
 * seconds, so a file the agent names and then creates links once it
 * exists. A stale answer stands while the new one comes, so nothing
 * flickers; a finished answer asked as of its time shows what it showed
 * while streaming until then.
 */
export type FileAnswer = FileResolution | null | undefined

interface Kept {
  answer: FileResolution | null
  at: number
  /** The person picked it: it stands for this transcript. */
  chosen?: boolean
}

const FOUND_MS = 60_000
const UNSURE_MS = 10_000
const MAX_KEPT = 20_000
const MAX_BATCH = 400

const kept = new Map<string, Kept>()
const inFlight = new Set<string>()
const asking = new Map<string, { source: FileReferenceSource; spellings: Set<string> }>()
const listeners = new Map<string, Set<() => void>>()
let scheduled = false

const transcriptKey = (source: FileReferenceSource) => `${source.liveId ?? ""}\u0001${source.threadPath ?? ""}`
const sourceKey = (source: FileReferenceSource) => `${transcriptKey(source)}\u0001${source.asOf ?? ""}`
const keyOf = (source: FileReferenceSource, spelling: string) => `${sourceKey(source)}\u0000${spelling}`
/** The answer the same spelling had as of now, standing in until the one as of `asOf` comes. */
const streamedKey = (source: FileReferenceSource, spelling: string) => keyOf({ liveId: source.liveId, threadPath: source.threadPath }, spelling)

function fresh(entry: Kept | undefined, now: number): boolean {
  if (!entry) return false
  if (entry.chosen) return true
  return now - entry.at < (entry.answer?.kind === "file" ? FOUND_MS : UNSURE_MS)
}

function ask(source: FileReferenceSource, spelling: string, key: string): void {
  if (inFlight.has(key)) return
  inFlight.add(key)
  const group = sourceKey(source)
  let batch = asking.get(group)
  if (!batch) asking.set(group, (batch = { source, spellings: new Set() }))
  batch.spellings.add(spelling)
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    const batches = [...asking.values()]
    asking.clear()
    for (const { source: from, spellings } of batches) {
      const all = [...spellings]
      for (let i = 0; i < all.length; i += MAX_BATCH) void send(from, all.slice(i, i + MAX_BATCH))
    }
  })
}

async function send(source: FileReferenceSource, spellings: string[]): Promise<void> {
  let answers: readonly (FileResolution | null)[]
  try {
    answers = (hasBridge() ? await getMako().resolveFileReferences(source, spellings) : null) ?? []
  } catch {
    answers = []
  }
  const at = Date.now()
  spellings.forEach((spelling, i) => {
    const key = keyOf(source, spelling)
    inFlight.delete(key)
    if (kept.get(key)?.chosen) return
    kept.delete(key)
    kept.set(key, { answer: answers[i] ?? null, at })
    for (const listener of listeners.get(key) ?? []) listener()
  })
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!)
}

/** The file `spelling` means in this transcript, as the host resolves it. */
export function useFileReference(source: FileReferenceSource, spelling: string | undefined): FileAnswer {
  const key = spelling === undefined ? "" : keyOf(source, spelling)
  return useSyncExternalStore(
    (listener) => {
      if (!key) return () => undefined
      let set = listeners.get(key)
      if (!set) listeners.set(key, (set = new Set()))
      set.add(listener)
      return () => {
        set.delete(listener)
        if (!set.size) listeners.delete(key)
      }
    },
    () => {
      if (spelling === undefined) return null
      const entry = kept.get(key)
      if (!fresh(entry, Date.now())) ask(source, spelling, key)
      if (entry) return entry.answer
      return source.asOf === undefined ? undefined : kept.get(streamedKey(source, spelling))?.answer
    },
  )
}

/**
 * The files to preview for these spellings, once each is answered: a found
 * file at its path now, a spelling the host can't check as written, and
 * nothing for a spelling with no file or a tie. Undefined while asking, so
 * previews appear once instead of one by one. A `bare` name (`shot.png`)
 * previews only as a file the Thread touched: never unchecked.
 */
export function useResolvedPaths(source: FileReferenceSource, spellings: readonly string[], bare?: ReadonlySet<string>): string[] | undefined {
  const keys = spellings.map((spelling) => keyOf(source, spelling))
  const signature = useSyncExternalStore(
    (listener) => {
      const sets = keys.map((key) => {
        let set = listeners.get(key)
        if (!set) listeners.set(key, (set = new Set()))
        set.add(listener)
        return set
      })
      return () => sets.forEach((set) => set.delete(listener))
    },
    () => {
      const now = Date.now()
      const paths: string[] = []
      for (const [i, spelling] of spellings.entries()) {
        const own = kept.get(keys[i]!)
        if (!fresh(own, now)) ask(source, spelling, keys[i]!)
        const entry = own ?? (source.asOf === undefined ? undefined : kept.get(streamedKey(source, spelling)))
        if (!entry) return ASKING
        if (bare?.has(spelling)) {
          if (entry.answer?.kind === "file" && entry.answer.file.touch) paths.push(entry.answer.file.path)
        } else if (entry.answer === null) paths.push(spelling)
        else if (entry.answer.kind === "file") paths.push(entry.answer.file.path)
      }
      return paths.join("\u0000")
    },
  )
  if (signature === ASKING) return undefined
  return signature ? signature.split("\u0000") : []
}

const ASKING = "\u0001asking"

/**
 * The person picked a file in the chooser: in this Thread, that spelling
 * means it from now on. Kept here at once and in the host's journal, after
 * which the transcript's other ties are asked again.
 */
export function chooseFileReference(source: FileReferenceSource, spelling: string, answer: FileResolution & { kind: "file" }): void {
  const key = keyOf(source, spelling)
  kept.delete(key)
  kept.set(key, { answer, at: Date.now(), chosen: true })
  for (const listener of listeners.get(key) ?? []) listener()
  if (!hasBridge()) return
  void getMako().chooseFileReference(source, spelling, answer.file.path).then(() => {
    const transcript = `${transcriptKey(source)}\u0001`
    for (const [other, entry] of kept) {
      if (other === key || entry.chosen || entry.answer?.kind !== "choice" || !other.startsWith(transcript)) continue
      kept.delete(other)
      for (const listener of listeners.get(other) ?? []) listener()
    }
  }, () => undefined)
}

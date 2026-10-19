import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { buildTranscript, ChildSidecars, toolIdsOf, transcriptNote, transcriptTurns, translatorBuild, withTranscriptNote, writeTranscript } from "@mako/sessions"
import type { BundledChildren, ChildParent, ChildSource, Thread, ThreadRef } from "@mako/sessions"
import type { LiveSnapshot } from "../contracts/live-conversations.js"
import type { ContextManifest } from "../contracts/conversation-control.js"
import type { Entry } from "@mako/sessions/entries"

/** Use the captured live history, never a native file that may trail the stream. */
export function liveEntries(blocks: readonly Entry[]): Entry[] {
  const entries: Entry[] = []
  for (const block of blocks) {
    if (block.type === "thinking") continue
    if (block.type === "user") {
      const text = block.contextFiles?.length ? `${block.text}\n\nContext supplied with this request:\n${block.contextFiles.join("\n")}` : block.text
      entries.push({ ...block, id: block.requestId ?? block.id, text })
    } else if (block.type === "tool") {
      entries.push({ ...block, output: [`Tool status: ${block.status}`, block.output].filter(Boolean).join("\n") })
    } else entries.push(block)
  }
  return entries
}

/**
 * What a host keeps for the transcripts it writes: each children folder's
 * sidecars, so a folder is swept at most hourly, the hash of the code that
 * decodes, which costs more than a page to make, and how it names harnesses.
 */
export class ContextBundles {
  /**
   * The catalog's listing and reader of the conversation's native sessions:
   * their child agents come with the transcript, and an imported history
   * decoded by older code is read again. Without it the transcript carries
   * no children.
   */
  readonly native?: ChildSource
  /** A harness's id as people read it; the id when the host gave no registry. */
  readonly label: (harness: string) => string
  private readonly folders = new Map<string, ChildSidecars>()
  private build?: string

  constructor(native?: ChildSource, label: (harness: string) => string = (harness) => harness) {
    this.native = native
    this.label = label
  }

  sidecars(folder: string): ChildSidecars {
    let sidecars = this.folders.get(folder)
    if (!sidecars) this.folders.set(folder, (sidecars = new ChildSidecars(folder, this.label)))
    return sidecars
  }

  translator(): string {
    return (this.build ??= translatorBuild())
  }
}

interface ContextInput {
  snapshot: LiveSnapshot
  root: string
  fromBlock: number
  includesBase: boolean
  bundles: ContextBundles
}

/**
 * `snapshot` with its imported history as this build decodes it. A base
 * keeps what the decoder that captured it made of each record (a report it
 * dropped, say) until the conversation is read back, and one that has run in
 * more than one harness never is. Each base entry its native record still
 * has, by id, is taken as the reader gives it now; the rest stay, and every
 * entry keeps its place, so the base still meets the live blocks it covers.
 */
async function withCurrentBase(snapshot: LiveSnapshot, bundles: ContextBundles): Promise<LiveSnapshot> {
  const base = snapshot.base
  const native = bundles.native
  if (!base || !native || base.translator === bundles.translator()) return snapshot
  const fresh = await native.open(base.ref.path).catch(() => null)
  if (!fresh || fresh.ref.nativeId !== base.ref.nativeId || fresh.ref.harness !== base.ref.harness) return snapshot
  const byId = new Map<string, Entry | null>()
  for (const entry of fresh.entries) if (entry.id) byId.set(entry.id, byId.has(entry.id) ? null : entry)
  let changed = false
  const entries = base.entries.map((entry) => {
    const now = entry.id ? byId.get(entry.id) : undefined
    if (!now || now.type !== entry.type || isDeepStrictEqual(now, entry)) return entry
    changed = true
    return now
  })
  return changed ? { ...snapshot, base: { ...base, entries } } : snapshot
}

/**
 * The native sessions whose entries `thread` carries: the history it was
 * imported from and each session it ran in. A child agent comes with the
 * bundle when the call that started it is one `thread` carries, or, for a
 * bundle from the conversation's start, when its harness recorded no call.
 */
function childParents(snapshot: LiveSnapshot, thread: Thread, fromBlock: number, includesBase: boolean): ChildParent[] {
  const paths = new Set<string>()
  if (includesBase && snapshot.base) paths.add(snapshot.base.ref.path)
  for (const binding of snapshot.control?.bindings ?? []) if (binding.path) paths.add(binding.path)
  if (snapshot.session.nativePath) paths.add(snapshot.session.nativePath)
  const toolIds = toolIdsOf(thread.entries)
  const whole = fromBlock === 0 && (includesBase || !snapshot.base)
  return [...paths].map((path) => ({ path, toolIds, whole }))
}

/** The children of `thread`'s sessions, each built beside the transcripts under `root`. */
async function carriedChildren(snapshot: LiveSnapshot, thread: Thread, input: Pick<ContextInput, "root" | "fromBlock" | "includesBase" | "bundles">): Promise<BundledChildren | null> {
  const native = input.bundles.native
  if (!native) return null
  return input.bundles.sidecars(join(input.root, CHILDREN_FOLDER)).bundle(native, childParents(snapshot, thread, input.fromBlock, input.includesBase))
}

/** Beside the transcripts in a context root; one links a child as `../children/…`. */
const CHILDREN_FOLDER = "children"

function capturedRef(snapshot: LiveSnapshot): ThreadRef {
  return snapshot.base?.ref ?? {
    path: snapshot.threadPath ?? snapshot.session.id,
    nativeId: snapshot.session.nativeId ?? snapshot.session.id,
    harness: snapshot.session.harness,
    cwd: snapshot.session.cwd,
    title: snapshot.session.title,
  }
}

/** The conversation from `fromBlock` on as one thread, with the imported base first when asked. */
export function capturedThread(
  snapshot: LiveSnapshot,
  fromBlock: number,
  includesBase: boolean
): Thread {
  return {
    ref: capturedRef(snapshot),
    entries: [
      ...(includesBase ? (snapshot.base?.entries ?? []) : []),
      ...liveEntries(snapshot.blocks.slice(includesBase ? Math.max(fromBlock, snapshot.baseCoveredBlocks ?? 0) : fromBlock)),
    ],
  }
}

/**
 * The entries a transcript carries from `fromBlock` on, as the conversation
 * holds them (thinking, statuses and all), with the imported base first when
 * asked, and the turns before them, to number its turns from.
 */
interface CarriedEntries {
  entries: Entry[]
  /** What came before them, which their turns are numbered after. */
  earlier: Entry[]
}

function carriedEntries(snapshot: LiveSnapshot, fromBlock: number, includesBase: boolean): CarriedEntries {
  const covered = snapshot.baseCoveredBlocks ?? 0
  const base = snapshot.base?.entries ?? []
  if (includesBase) return { entries: [...base, ...snapshot.blocks.slice(Math.max(fromBlock, covered))], earlier: [] }
  return { entries: snapshot.blocks.slice(fromBlock), earlier: [...base, ...snapshot.blocks.slice(covered, Math.max(fromBlock, covered))] }
}

/** The harnesses that wrote `entries`, in the order they first appear: the imported history's, then each prompt's. */
function writers(snapshot: LiveSnapshot, entries: readonly Entry[], includesBase: boolean): string[] {
  const from = new Set<string>()
  if (includesBase && snapshot.base?.entries.length) from.add(snapshot.base.ref.harness)
  for (const entry of entries) if (entry.type === "user" && entry.provider) from.add(entry.provider)
  if (!from.size) from.add(snapshot.session.harness)
  return [...from]
}

/** Harnesses as people read them, for a transcript's header and note. */
function harnessNames(from: readonly string[], label: (harness: string) => string): string {
  return from.map(label).join(", ")
}

/**
 * The conversation from `fromBlock` on, written down as a transcript under
 * `root` (`buildTranscript`), with its child agents beside it: what a
 * request that hands it over names (`contextPrompt`).
 */
export async function prepareLiveContext(
  input: ContextInput
): Promise<ContextManifest> {
  const { root, fromBlock, includesBase } = input
  const snapshot = includesBase ? await withCurrentBase(input.snapshot, input.bundles) : input.snapshot
  const { entries, earlier } = carriedEntries(snapshot, fromBlock, includesBase)
  const thread = { ref: capturedRef(snapshot), entries }
  const carried = await carriedChildren(snapshot, thread, input)
  const from = writers(snapshot, entries, includesBase)
  const title = snapshot.session.title ?? thread.ref.title
  const cwd = snapshot.session.cwd ?? thread.ref.cwd
  const built = await buildTranscript({
    entries,
    harness: harnessNames(from, input.bundles.label),
    label: input.bundles.label,
    firstTurn: transcriptTurns(earlier) + 1,
    ...title !== undefined && { title },
    ...cwd !== undefined && { cwd },
    ...carried && { children: carried.children },
  })
  const file = await writeTranscript(root, built)
  const folder = dirname(file)
  return {
    file,
    resources: [
      ...built.files.map((entry) => join(folder, entry.name)),
      ...carried?.files ?? [],
    ],
    digest: built.digest,
    sourceRevision: snapshot.revision,
    fromBlock,
    toBlock: snapshot.blocks.length,
    includesBase,
    losses: [
      ...built.losses,
      ...(includesBase && snapshot.base?.hasEarlier
        ? ["Earlier native history is not present in this capture"]
        : []),
    ],
    turns: built.turns,
    from,
  }
}

/** The request as the destination's first turn sends it: the transcript's note, then what the person asked. */
export function contextPrompt(manifest: ContextManifest, text: string, label: (harness: string) => string = (harness) => harness): string {
  const note = transcriptNote(manifest.file, { turns: manifest.turns ?? 0, losses: manifest.losses }, harnessNames(manifest.from ?? [], label) || "another harness")
  return withTranscriptNote(note, text)
}

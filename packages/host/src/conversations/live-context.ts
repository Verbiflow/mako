import { createHash, randomUUID } from "node:crypto"
import { mkdir, writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { attachmentFiles, ChildSidecars, renderTranscriptBundle, toolIdsOf, translatorBuild, withChildReferences, withContext } from "@mako/sessions"
import { persistThreadAttachments } from "@mako/sessions/attachment-storage"
import type { BundledChildren, ChildParent, ChildSource, Thread } from "@mako/sessions"
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
 * What a host keeps for the context bundles it writes: each children
 * folder's sidecars, so a folder is swept at most hourly, and the hash of
 * the code that decodes, which costs more than a page to make.
 */
export class ContextBundles {
  /**
   * The catalog's listing and reader of the conversation's native sessions:
   * their child agents come with the bundle, and an imported history decoded
   * by older code is read again. Without it the bundle carries no children.
   */
  readonly native?: ChildSource
  private readonly folders = new Map<string, ChildSidecars>()
  private build?: string

  constructor(native?: ChildSource) {
    this.native = native
  }

  sidecars(folder: string): ChildSidecars {
    let sidecars = this.folders.get(folder)
    if (!sidecars) this.folders.set(folder, (sidecars = new ChildSidecars(folder)))
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

/** The children of `thread`'s sessions, each rendered beside the bundles under `root`. */
async function carriedChildren(snapshot: LiveSnapshot, thread: Thread, input: Pick<ContextInput, "root" | "fromBlock" | "includesBase" | "bundles">): Promise<{ sidecars: ChildSidecars; bundled: BundledChildren } | null> {
  const native = input.bundles.native
  if (!native) return null
  const sidecars = input.bundles.sidecars(join(input.root, CHILDREN_FOLDER))
  const bundled = await sidecars.bundle(native, childParents(snapshot, thread, input.fromBlock, input.includesBase))
  return { sidecars, bundled }
}

/** Beside the bundles in a context root; a bundle links a child as `../children/…`. */
const CHILDREN_FOLDER = "children"

/**
 * The whole conversation for a destination that opens on it in its own
 * store: its imported history decoded by this build, and each call that
 * started a child agent saying where that child's transcript is, since no
 * bundle indexes its children there.
 */
export async function capturedHandoff(snapshot: LiveSnapshot, root: string, bundles: ContextBundles): Promise<Thread> {
  const current = await withCurrentBase(snapshot, bundles)
  const thread = capturedThread(current, 0, true)
  const carried = await carriedChildren(current, thread, { root, fromBlock: 0, includesBase: true, bundles }).catch(() => null)
  return carried ? withChildReferences(thread, carried.bundled.children, (link) => carried.sidecars.file(link)) : thread
}

/** The conversation from `fromBlock` on as one thread, with the imported base first when asked. */
export function capturedThread(
  snapshot: LiveSnapshot,
  fromBlock: number,
  includesBase: boolean
): Thread {
  return {
    ref: snapshot.base?.ref ?? {
      path: snapshot.threadPath ?? snapshot.session.id,
      nativeId: snapshot.session.nativeId ?? snapshot.session.id,
      harness: snapshot.session.harness,
      cwd: snapshot.session.cwd,
      title: snapshot.session.title,
    },
    entries: [
      ...(includesBase ? (snapshot.base?.entries ?? []) : []),
      ...liveEntries(snapshot.blocks.slice(includesBase ? Math.max(fromBlock, snapshot.baseCoveredBlocks ?? 0) : fromBlock)),
    ],
  }
}

export async function prepareLiveContext(
  input: ContextInput
): Promise<ContextManifest> {
  const { root, fromBlock, includesBase } = input
  const snapshot = includesBase ? await withCurrentBase(input.snapshot, input.bundles) : input.snapshot
  const thread = capturedThread(snapshot, fromBlock, includesBase)
  const retained = await persistThreadAttachments(
    thread,
    join(root, "attachments")
  )
  const carried = await carriedChildren(snapshot, retained, input)
  const bundle = renderTranscriptBundle(retained, {
    mainBudget: Infinity,
    totalBudget: Infinity,
    ...carried && { children: carried.bundled.children },
  })
  const digest = createHash("sha256").update(bundle.markdown)
  for (const asset of bundle.assets)
    digest.update(asset.path).update("\0").update(asset.content)
  const hash = digest.digest("hex")
  const directory = join(root, hash)
  await mkdir(directory, { recursive: true })
  for (const asset of bundle.assets) {
    const destination = join(directory, asset.path)
    await mkdir(join(destination, ".."), { recursive: true })
    const temporary = `${destination}.${randomUUID()}.tmp`
    await writeFile(temporary, asset.content, {
      encoding: asset.encoding ?? "utf8",
      mode: 0o600,
    })
    await rename(temporary, destination)
  }
  const file = join(directory, "transcript.md")
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, bundle.markdown, { mode: 0o600 })
  await rename(temporary, file)
  return {
    file,
    resources: [
      ...bundle.assets.map((asset) => join(directory, asset.path)),
      ...attachmentFiles(retained.entries),
      ...carried?.bundled.files ?? [],
    ],
    digest: hash,
    sourceRevision: snapshot.revision,
    fromBlock,
    toBlock: snapshot.blocks.length,
    includesBase,
    losses: [
      ...bundle.metadata.losses.map((loss) => JSON.stringify(loss)),
      ...(includesBase && snapshot.base?.hasEarlier
        ? ["Earlier native history is not present in this capture"]
        : []),
    ],
  }
}

export function contextPrompt(manifest: ContextManifest, text: string): string {
  return withContext(manifest.file, manifest.losses, text)
}

import { createHash, randomUUID } from "node:crypto"
import { mkdir, writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { attachmentFiles, childSidecarsAt, renderTranscriptBundle, toolIdsOf, translatorBuild, withChildReferences, withContext } from "@mako/sessions"
import { persistThreadAttachments } from "@mako/sessions/attachment-storage"
import { AGENT_PLAN_TOOL } from "@mako/sessions/tool-identity"
import type { BundledChildren, ChildParent, ChildSidecars, ChildSource, ThreadEntry, Thread } from "@mako/sessions"
import type { LiveSnapshot } from "../contracts/live-conversations.js"
import type { LiveBlock } from "@mako/sessions/live-content"
import type { ContextManifest } from "../contracts/conversation-control.js"

/** Use the captured live history, never a native file that may trail the stream. */
export function liveEntries(blocks: LiveBlock[]): ThreadEntry[] {
  const entries: ThreadEntry[] = []
  for (const block of blocks) {
    if (block.type === "user") {
      entries.push({
        kind: "user",
        id: block.requestId,
        steeringFor: block.steeringFor,
        text: block.contextFiles?.length
          ? `${block.text}\n\nContext supplied with this request:\n${block.contextFiles.join("\n")}`
          : block.text,
        attachments: block.attachments,
      })
      continue
    }
    if (block.type === "thinking") continue
    if (block.type === "provider-turn") {
      entries.push({ kind: "event", label: block.reason, ...block.at !== undefined && { at: new Date(block.at).toISOString() }, ...block.cause && { cause: block.cause }, ...block.body && { body: block.body }, opensTurn: true })
      continue
    }
    if (block.type === "event") {
      entries.push({
        kind: "event",
        id: block.id,
        label: block.label,
        detail: block.detail,
        body: block.body,
        cause: block.cause,
        tone: block.tone,
        source: block.source,
      })
      continue
    }
    if (block.type === "plan") {
      entries.push({
        kind: "assistant",
        blocks: [
          {
            type: "tool",
            name: AGENT_PLAN_TOOL,
            output: "",
            details: [{ type: "plan", entries: block.entries }],
          },
        ],
      })
      continue
    }
    const previous = entries.at(-1)
    const assistant =
      previous?.kind === "assistant"
        ? previous
        : { kind: "assistant" as const, blocks: [] }
    if (assistant !== previous) entries.push(assistant)
    switch (block.type) {
      case "proposed-plan":
        assistant.blocks.push(block)
        break
      case "text":
        assistant.blocks.push({ type: "text", text: block.text })
        break
      case "attachment":
        assistant.blocks.push(block.attachment)
        break
      case "tool":
        assistant.blocks.push({
          type: "tool",
          id: block.id,
          name: block.name ?? block.toolKind ?? block.title,
          input: block.input,
          output: [`Tool status: ${block.status}`, block.output]
            .filter(Boolean)
            .join("\n"),
          error: block.status === "failed",
          canceled: /cancel/i.test(block.status),
          attachments: block.attachments,
          details: block.details,
        })
        break
    }
  }
  return entries
}

interface ContextInput {
  snapshot: LiveSnapshot
  root: string
  fromBlock: number
  includesBase: boolean
  /**
   * The catalog's listing and reader of the conversation's native sessions:
   * their child agents come with the bundle, and an imported history decoded
   * by older code is read again. Without it the bundle carries no children.
   */
  native?: ChildSource
}

let build: string | undefined

/**
 * `snapshot` with its imported history as this build decodes it. A base
 * keeps what the decoder that captured it made of each record (a report it
 * dropped, say) until the conversation is read back, and one that has run in
 * more than one harness never is. Each base entry its native record still
 * has, by id, is taken as the reader gives it now; the rest stay, and every
 * entry keeps its place, so the base still meets the live blocks it covers.
 */
async function withCurrentBase(snapshot: LiveSnapshot, native: ChildSource | undefined): Promise<LiveSnapshot> {
  const base = snapshot.base
  if (!base || !native || base.translator === (build ??= translatorBuild())) return snapshot
  const fresh = await native.open(base.ref.path).catch(() => null)
  if (!fresh || fresh.ref.nativeId !== base.ref.nativeId || fresh.ref.harness !== base.ref.harness) return snapshot
  const byId = new Map<string, ThreadEntry | null>()
  for (const entry of fresh.entries) if (entry.id) byId.set(entry.id, byId.has(entry.id) ? null : entry)
  let changed = false
  const entries = base.entries.map((entry) => {
    const now = entry.id ? byId.get(entry.id) : undefined
    if (!now || now.kind !== entry.kind || isDeepStrictEqual(now, entry)) return entry
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
async function carriedChildren(snapshot: LiveSnapshot, thread: Thread, input: Pick<ContextInput, "root" | "fromBlock" | "includesBase" | "native">): Promise<{ sidecars: ChildSidecars; bundled: BundledChildren } | null> {
  if (!input.native) return null
  const sidecars = childSidecarsAt(join(input.root, CHILDREN_FOLDER))
  const bundled = await sidecars.bundle(input.native, childParents(snapshot, thread, input.fromBlock, input.includesBase))
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
export async function capturedHandoff(snapshot: LiveSnapshot, root: string, native: ChildSource | undefined): Promise<Thread> {
  const current = await withCurrentBase(snapshot, native)
  const thread = capturedThread(current, 0, true)
  const carried = await carriedChildren(current, thread, { root, fromBlock: 0, includesBase: true, native }).catch(() => null)
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
  const snapshot = includesBase ? await withCurrentBase(input.snapshot, input.native) : input.snapshot
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

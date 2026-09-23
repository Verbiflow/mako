import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, link, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import type { AttachmentContent } from "./content.js"
import type { Thread } from "./format.js"

type FileSource = Extract<AttachmentContent["source"], { kind: "file" }>

function assetName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "attachment"
}

/** Existing retained paths already encode their snapshot's SHA-256. No migration. */
function snapshotDigest(source: FileSource, name: string): string | undefined {
  const match = /^([a-f0-9]{64})-(.+)$/.exec(basename(source.path))
  return match && (source.originalPath || match[2] === assetName(name))
    ? match[1]
    : undefined
}

async function fileDigest(path: string): Promise<string> {
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest("hex")
}

async function intact(path: string, digest: string): Promise<boolean> {
  try {
    // A symlink back to a provider's temporary file is not an independent copy.
    return (await lstat(path)).isFile() && (await fileDigest(path)) === digest
  } catch {
    return false
  }
}

async function fileSnapshot(source: FileSource, name: string) {
  const expected = snapshotDigest(source, name)
  if (!expected) return { path: source.path, digest: await fileDigest(source.path) }
  if (await intact(source.path, expected))
    return { path: source.path, digest: expected, expected }
  if (source.originalPath && await intact(source.originalPath, expected))
    return { path: source.originalPath, digest: expected, expected }
  throw new Error("The retained attachment is missing or damaged and its original bytes are unavailable")
}

/** Publish complete bytes; independent processes can race without a shared lock. */
async function publish(temporary: string, path: string, digest: string): Promise<void> {
  try {
    // Unlike rename, link does not replace an intact winner from another writer.
    await link(temporary, path)
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code !== "EEXIST") throw error
    if (await intact(path, digest)) return
    // The destination is corrupt. Atomic replacement never exposes a partial copy.
    // Concurrent repairs can only publish bytes for this same content address.
    await rename(temporary, path)
  }
}

/** Retain original attachment bytes independently of a provider's temporary file. */
export async function persistThreadAttachments(
  thread: Thread,
  root: string,
  previous?: Thread | null
): Promise<Thread> {
  const retained = new Map<string, AttachmentContent>()
  for (const entry of previous?.entries ?? []) {
    const attachments =
      entry.kind === "user"
        ? (entry.attachments ?? [])
        : entry.kind === "assistant"
          ? entry.blocks.flatMap((block) =>
              block.type === "attachment"
                ? [block]
                : block.type === "tool"
                  ? (block.attachments ?? [])
                  : []
            )
          : []
    for (const attachment of attachments)
      if (attachment.source.kind === "file" && attachment.source.originalPath)
        retained.set(attachment.source.originalPath, attachment)
  }
  const save = async (
    attachment: AttachmentContent
  ): Promise<AttachmentContent> => {
    if (
      attachment.source.kind === "url" ||
      attachment.source.kind === "unavailable"
    )
      return attachment
    let temporary: string | undefined
    let digest: string | undefined
    const retainedSource = (path: string): AttachmentContent => ({
      ...attachment,
      source: {
        kind: "file",
        path,
        originalPath: attachment.source.kind === "file"
          ? (attachment.source.originalPath ?? attachment.source.path)
          : undefined,
      },
    })
    try {
      const bytes = attachment.source.kind === "inline"
        ? Buffer.from(attachment.source.data, "base64")
        : undefined
      const snapshot = attachment.source.kind === "file"
        ? await fileSnapshot(attachment.source, attachment.name)
        : undefined
      digest = snapshot?.digest ?? createHash("sha256").update(bytes!).digest("hex")
      const name = assetName(attachment.name)
      let path = join(root, `${digest}-${name}`)
      if (await intact(path, digest)) return retainedSource(path)

      await mkdir(root, { recursive: true })
      temporary = join(root, `${randomUUID()}.tmp`)
      if (snapshot) {
        await copyFile(snapshot.path, temporary)
        // The original may change between hashing and copying. Address the bytes
        // actually retained, and never substitute new bytes for a historical image.
        digest = await fileDigest(temporary)
        if (snapshot.expected && digest !== snapshot.expected)
          throw new Error("The original attachment changed while recovering its retained copy")
        path = join(root, `${digest}-${name}`)
      } else await writeFile(temporary, bytes!)
      await publish(temporary, path, digest)
      return retainedSource(path)
    } catch (error) {
      if (attachment.source.kind === "inline") return attachment
      const existing = retained.get(
        attachment.source.originalPath ?? attachment.source.path
      )
      if (existing?.source.kind === "file") {
        try {
          const snapshot = await fileSnapshot(existing.source, existing.name)
          // A failed save of known new bytes must not report an older copy as saved.
          if (!digest || snapshot.digest === digest) {
            const expected = snapshotDigest(attachment.source, attachment.name)
            if (!expected || expected === snapshot.digest) {
              const recovered = await persistThreadAttachments({
                ...thread,
                entries: [{ kind: "user", text: "", attachments: [existing] }],
              }, root)
              const entry = recovered.entries[0]
              const fallback = entry?.kind === "user" ? entry.attachments?.[0] : undefined
              if (fallback?.source.kind === "file") return { ...attachment, source: fallback.source }
            }
          }
        } catch {
          // Neither a missing nor a corrupt previous copy is a successful fallback.
        }
      }
      return {
        ...attachment,
        source: {
          kind: "unavailable",
          reason: `The original attachment could not be retained: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    } finally {
      if (temporary) await rm(temporary, { force: true })
    }
  }

  const entries = []
  for (const entry of thread.entries) {
    if (entry.kind === "user" && entry.attachments) {
      const attachments = []
      for (const attachment of entry.attachments ?? [])
        attachments.push(await save(attachment))
      entries.push({ ...entry, attachments })
    } else if (entry.kind === "assistant") {
      const blocks = []
      for (const block of entry.blocks) {
        if (block.type === "attachment") blocks.push(await save(block))
        else if (block.type === "tool" && block.attachments) {
          const attachments = []
          for (const attachment of block.attachments)
            attachments.push(await save(attachment))
          blocks.push({ ...block, attachments })
        } else blocks.push(block)
      }
      entries.push({ ...entry, blocks })
    } else entries.push(entry)
  }
  return { ...thread, entries }
}

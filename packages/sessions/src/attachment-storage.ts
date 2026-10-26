import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import {
  copyFile,
  link,
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { basename, join } from "node:path"
import type { AttachmentContent } from "./content.js"
import type { Thread } from "./format.js"
import { entryAttachments, type Entry } from "./entries.js"

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
  if (!expected)
    return { path: source.path, digest: await fileDigest(source.path) }
  if (await intact(source.path, expected))
    return { path: source.path, digest: expected, expected }
  if (source.originalPath && (await intact(source.originalPath, expected)))
    return { path: source.originalPath, digest: expected, expected }
  throw new Error(
    "The retained attachment is missing or damaged and its original bytes are unavailable"
  )
}

/** Publish complete bytes; independent processes can race without a shared lock. */
async function publish(
  temporary: string,
  path: string,
  digest: string
): Promise<void> {
  try {
    // Unlike rename, link does not replace an intact winner from another writer.
    await link(temporary, path)
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined
    if (
      !["EEXIST", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"].includes(
        String(code)
      )
    )
      throw error
    if (await intact(path, digest)) return
    // Repair corruption, or use atomic rename on a filesystem without hard links.
    // Concurrent repairs can only publish bytes for this same content address.
    await rename(temporary, path)
  }
}

/**
 * A copy of the file at `path` in `root`, named by the SHA-256 of the bytes
 * copied (`<digest><extension>`), so every holder of the same bytes shares
 * one. The copy is a copy-on-write clone where the file system makes one
 * (APFS), which costs no space until either side changes; the bytes kept are
 * what was copied, whatever the original becomes.
 */
export async function keepFileCopy(path: string, root: string, extension: string): Promise<{ path: string; digest: string }> {
  await mkdir(root, { recursive: true })
  const temporary = join(root, `${randomUUID()}.tmp`)
  try {
    await copyFile(path, temporary, constants.COPYFILE_FICLONE)
    const digest = await fileDigest(temporary)
    const kept = join(root, `${digest}${extension}`)
    if (!(await intact(kept, digest))) await publish(temporary, kept, digest)
    return { path: kept, digest }
  } finally {
    await rm(temporary, { force: true })
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
    for (const attachment of entryAttachments(entry))
      if (attachment.source.kind === "file" && attachment.source.originalPath)
        retained.set(attachment.source.originalPath, attachment)
  }
  const save = async (
    attachment: AttachmentContent,
    allowFallback = true
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
        originalPath:
          attachment.source.kind === "file"
            ? (attachment.source.originalPath ??
              (snapshotDigest(attachment.source, attachment.name)
                ? undefined
                : attachment.source.path))
            : undefined,
      },
    })
    try {
      const input =
        attachment.source.kind === "file"
          ? {
              kind: "file" as const,
              ...(await fileSnapshot(attachment.source, attachment.name)),
            }
          : {
              kind: "inline" as const,
              bytes: Buffer.from(attachment.source.data, "base64"),
            }
      digest =
        input.kind === "file"
          ? input.digest
          : createHash("sha256").update(input.bytes).digest("hex")
      const name = assetName(attachment.name)
      let path = join(root, `${digest}-${name}`)
      if (
        input.kind === "file" &&
        input.path === path &&
        input.expected === digest
      )
        return retainedSource(path)
      if (await intact(path, digest)) return retainedSource(path)

      await mkdir(root, { recursive: true })
      temporary = join(root, `${randomUUID()}.tmp`)
      if (input.kind === "file") {
        await copyFile(input.path, temporary)
        // The original may change between hashing and copying. Address the bytes
        // actually retained, and never substitute new bytes for a historical image.
        digest = await fileDigest(temporary)
        if (input.expected && digest !== input.expected)
          throw new Error(
            "The original attachment changed while recovering its retained copy"
          )
        path = join(root, `${digest}-${name}`)
      } else await writeFile(temporary, input.bytes)
      await publish(temporary, path, digest)
      return retainedSource(path)
    } catch (error) {
      if (attachment.source.kind === "inline") return attachment
      const existing = retained.get(
        attachment.source.originalPath ?? attachment.source.path
      )
      if (allowFallback && existing?.source.kind === "file") {
        try {
          const snapshot = await fileSnapshot(existing.source, existing.name)
          // A failed save of known new bytes must not report an older copy as saved.
          if (!digest || snapshot.digest === digest) {
            const expected = snapshotDigest(attachment.source, attachment.name)
            if (!expected || expected === snapshot.digest) {
              const fallback = await save(existing, false)
              if (fallback?.source.kind === "file")
                return { ...attachment, source: fallback.source }
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

  const entries: Entry[] = []
  for (const entry of thread.entries) {
    if (entry.type === "attachment") entries.push({ ...entry, attachment: await save(entry.attachment) })
    else if ((entry.type === "user" || entry.type === "tool") && entry.attachments) {
      const attachments = []
      for (const attachment of entry.attachments) attachments.push(await save(attachment))
      entries.push({ ...entry, attachments })
    } else entries.push(entry)
  }
  return { ...thread, entries }
}

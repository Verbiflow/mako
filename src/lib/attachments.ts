import { mediaTypeForPath } from "./transcript-media"
import {
  readAttachmentDrafts,
  writeAttachmentDrafts,
} from "./draft-persistence"
import { useCallback, useEffect, useRef, useState } from "react"
import { getMako } from "@/lib/bridge"
import { toast } from "sonner"
import {
  attachmentReference,
  attachmentRanges,
  attachmentPromptText,
  namedAttachmentReference,
  mergeAttachmentDraft,
  pasteAttachmentDraft,
} from "./attachment-references"

/**
 * Attachments.
 *
 * Anything can be attached. What differs is how it reaches the agent:
 *
 *   image  → inline when the provider supports image blocks
 *   text   → inlined into the prompt as a labelled block
 *   binary → written to a scratch file, with the path handed to the provider
 *
 * A PDF or a video therefore attaches like anything else and stays reachable,
 * rather than being refused for not fitting the model's inline contract.
 *
 * Filename references preserve each file's position in the draft. The composer
 * paints these as removable chips; the provider receives the same filenames
 * with an appendix that points to their staged contents.
 */

export type AttachmentInput = File | { file: File; context?: string; contextLabel?: string }

export type AttachmentKind = "image" | "text" | "binary"

export interface Attachment {
  id: string
  reference?: string
  /** Compact, named context instead of a media/file thumbnail. */
  contextLabel?: string
  /** 1-based, matching the `[Attachment N]` marker in the draft. */
  index: number
  name: string
  mimeType: string
  size: number
  kind: AttachmentKind
  /** Base64, for images. */
  data?: string
  /** Decoded contents, for text-ish files. */
  text?: string
  /** Object URL, for image thumbnails. */
  preview?: string
  /** Scratch-file path, for anything the model cannot take inline. */
  stagedPath?: string
  /** Readable window context paired with an image capture. */
  contextPath?: string
  context?: string
  /** True while the file is being read or staged. */
  pending?: boolean
  error?: string
}

export interface InlineAttachmentImage {
  mimeType: string
  data: string
}

export interface AttachmentPrompt {
  text: string
  images: InlineAttachmentImage[]
}

export interface AttachmentFileReference {
  index: number
  name: string
  path: string
  mimeType?: string
  contextPath?: string
}

export interface ParsedAttachmentAppendix {
  body: string
  files: AttachmentFileReference[]
}

interface PendingAttachment {
  attachment: Attachment
  file: File
}

const MAX_INLINE_TEXT = 200_000
const MAX_BYTES = 256 * 1024 * 1024
const EMPTY_ATTACHMENTS: Attachment[] = []

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "mdx",
  "rst",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "rb",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
  "html",
  "css",
  "scss",
  "svg",
  "xml",
  "patch",
  "diff",
  "log",
  "lock",
  "gradle",
  "make",
  "dockerfile",
])

export function classify(file: File): AttachmentKind {
  const mime = file.type || mediaTypeForPath(file.name) || "application/octet-stream"
  if (mime.startsWith("image/") && mime !== "image/svg+xml")
    return "image"
  const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) return "text"
  if (file.type === "application/json" || file.type === "application/xml")
    return "text"
  return "binary"
}

export function useAttachments(key = "default") {
  const [buckets, setBuckets] =
    useState<Record<string, Attachment[]>>(readAttachmentDrafts)
  const items = buckets[key] ?? EMPTY_ATTACHMENTS
  const nextIndex = useRef(new Map<string, number>())
  const live = useRef(new Map<string, Attachment[]>())
  const removed = useRef(new Map<string, Attachment[]>())
  const updateItems = useCallback(
    (update: (current: Attachment[]) => Attachment[]) =>
      setBuckets((current) => {
        const next = update(current[key] ?? [])
        live.current.set(key, next)
        return { ...current, [key]: next }
      }),
    [key]
  )
  const replaceItems = useCallback(
    (next: Attachment[]) => {
      live.current.set(key, next)
      setBuckets((current) => ({ ...current, [key]: next }))
    },
    [key]
  )

  useEffect(() => {
    writeAttachmentDrafts(buckets)
  }, [buckets])

  // Object URLs leak if the composer unmounts mid-draft. The mirror is written
  // in an effect so the unmount cleanup can read it without touching a ref
  // during render.
  useEffect(() => {
    live.current.set(key, items)
  }, [items, key])
  useEffect(() => {
    const bucketsAtUnmount = live.current
    const removedAtUnmount = removed.current
    return () => {
      for (const bucket of [
        ...bucketsAtUnmount.values(),
        ...removedAtUnmount.values(),
      ]) {
        for (const item of bucket) {
          if (item.preview) URL.revokeObjectURL(item.preview)
        }
      }
    }
  }, [])

  /** Returns the markers to insert, so the caller can place them at the caret. */
  const add = useCallback(
    (files: AttachmentInput[]): string => {
      const accepted: PendingAttachment[] = []

      for (const input of files) {
        const file = input instanceof File ? input : input.file
        const context = input instanceof File ? undefined : input.context
        const contextLabel = input instanceof File ? undefined : input.contextLabel
        if (file.size > MAX_BYTES) {
          toast.error(`${file.name} is larger than 256 MB`)
          continue
        }
        const kind = classify(file)
        const mimeType = file.type || mediaTypeForPath(file.name) || "application/octet-stream"
        const index = Math.max(
          nextIndex.current.get(key) ?? 1,
          ...(live.current.get(key) ?? []).map((item) => item.index + 1),
          ...(removed.current.get(key) ?? []).map((item) => item.index + 1)
        )
        nextIndex.current.set(key, index + 1)
        accepted.push({
          attachment: {
            id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
            index,
            name: file.name,
            contextLabel,
            reference: namedAttachmentReference(contextLabel ?? file.name, index, [
              ...(live.current.get(key) ?? []).map(attachmentReference),
              ...(removed.current.get(key) ?? []).map(attachmentReference),
              ...accepted.map((entry) => attachmentReference(entry.attachment)),
            ]),
            mimeType,
            size: file.size,
            kind,
            context,
            preview: /^(image|video|audio)\//.test(mimeType) ? URL.createObjectURL(file) : undefined,
            pending: true,
          },
          file,
        })
      }
      if (accepted.length === 0) return ""

      updateItems((current) => [
        ...current,
        ...accepted.map((entry) => entry.attachment),
      ])

      // Reading and staging happen after the chips are on screen, so a large
      // file never delays the acknowledgement that it was accepted.
      void Promise.all(
        accepted.map(async (entry) => {
          const { attachment, file } = entry
          try {
            const resolved = await resolve(attachment, file)
            removed.current.set(
              key,
              (removed.current.get(key) ?? []).map((item) =>
                item.id === attachment.id ? attachmentMetadata({ ...resolved, index: item.index, reference: item.reference }) : item
              )
            )
            updateItems((current) =>
              current.map((item) =>
                item.id === attachment.id
                  ? { ...resolved, index: item.index, reference: item.reference, preview: item.preview }
                  : item
              )
            )
          } catch (error) {
            toast.error(
              `Could not attach ${attachment.name}: ${error instanceof Error ? error.message : error}`
            )
            removed.current.set(
              key,
              (removed.current.get(key) ?? []).map((item) =>
                item.id === attachment.id
                  ? {
                      ...item,
                      pending: false,
                      error:
                        "Staging failed; remove and attach this file again",
                    }
                  : item
              )
            )
            updateItems((current) =>
              current.map((item) =>
                item.id === attachment.id
                  ? {
                      ...item,
                      pending: false,
                      error:
                        "Staging failed; remove and attach this file again",
                    }
                  : item
              )
            )
          }
        })
      )

      return accepted
        .map((entry) => attachmentReference(entry.attachment))
        .join(" ")
    },
    [key, updateItems]
  )

  /**
   * Resolves when no attachment is still reading or staging — the moment a
   * prompt that references them can actually be sent. Sending earlier is
   * how a message once went out with a dead [Attachment 1] marker and no
   * file behind it.
   */
  const settled = useCallback(async (): Promise<Attachment[]> => {
    const deadline = Date.now() + 20_000
    while (
      (live.current.get(key) ?? []).some((item) => item.pending) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    return live.current.get(key) ?? []
  }, [key])

  const remove = useCallback(
    (id: string) => {
      updateItems((current) => {
        const found = current.find((item) => item.id === id)
        if (found) {
          if (found.preview) URL.revokeObjectURL(found.preview)
          removed.current.set(key, [
            ...(removed.current.get(key) ?? []).filter(
              (item) => item.id !== id
            ),
            attachmentMetadata(found),
          ])
        }
        return current.filter((item) => item.id !== id)
      })
    },
    [key, updateItems]
  )

  const restoreRemoved = useCallback(
    (text: string) => {
      const bucket = removed.current.get(key) ?? []
      const referenced = new Set(attachmentRanges(text, [...(live.current.get(key) ?? []), ...bucket]).map((range) => range.item.id))
      const restoring = bucket.filter((item) => referenced.has(item.id))
      if (!restoring.length) return
      removed.current.set(
        key,
        bucket.filter((item) => !restoring.includes(item))
      )
      updateItems((current) => mergeAttachmentDraft(current, restoring))
    },
    [key, updateItems]
  )

  const clear = useCallback(() => {
    updateItems((current) => {
      for (const item of current)
        if (item.preview) URL.revokeObjectURL(item.preview)
      return []
    })
    nextIndex.current.set(key, 1)
  }, [key, updateItems])

  /**
   * Take the attachments off the composer *without* destroying them.
   *
   * Sending clears the composer before the host has accepted anything, so it
   * feels instant. That is only safe if a rejected send can put everything
   * back — and `clear` revokes the preview URLs, which would restore a strip
   * of broken images. These three let the caller hold the items until it knows
   * which way it went.
   */
  const detach = useCallback((): Attachment[] => {
    const taken = live.current.get(key) ?? []
    live.current.set(key, [])
    replaceItems([])
    return taken
  }, [key, replaceItems])

  const reattach = useCallback(
    (taken: Attachment[]) => {
      const combined = mergeAttachmentDraft(live.current.get(key) ?? [], taken)
      live.current.set(key, combined)
      replaceItems(combined)
    },
    [key, replaceItems]
  )

  const paste = useCallback((text: string, incoming: Attachment[]) => {
    const pasted = pasteAttachmentDraft(text, incoming, [
      ...(live.current.get(key) ?? []),
      ...(removed.current.get(key) ?? []),
    ])
    updateItems(current => [...current, ...pasted.attachments])
    return pasted.text
  }, [key, updateItems])

  const discard = useCallback((taken: Attachment[]) => {
    for (const item of taken)
      if (item.preview) URL.revokeObjectURL(item.preview)
    // A successful send must not remove attachments added to the next draft.
  }, [])

  return {
    items,
    add,
    remove,
    restoreRemoved,
    clear,
    detach,
    reattach,
    paste,
    discard,
    settled,
  }
}

async function resolve(
  attachment: Attachment,
  file: File
): Promise<Attachment> {
  const sourcePath = getMako().pathForFile?.(file) ?? null
  const data = sourcePath ? undefined : await toBase64(file)
  const staged = sourcePath
    ? await getMako().stageFilePath(sourcePath)
    : await getMako().stageFile(file.name, data ?? "")
  const text =
    attachment.kind === "text"
      ? await file.slice(0, MAX_INLINE_TEXT).text()
      : undefined
  const context = attachment.context
  const contextFile = context
    ? await getMako().stageFile(
        `${file.name}.context.txt`,
        await toBase64(
          new File([context], `${file.name}.context.txt`, {
            type: "text/plain",
          })
        )
      )
    : undefined
  return {
    ...attachment,
    stagedPath: staged.path,
    contextPath: contextFile?.path,
    data:
      attachment.kind === "image"
        ? (data ?? (await toBase64(file)))
        : undefined,
    text,
    pending: false,
  }
}

/**
 * The browser's own encoder, off the main thread — not a fromCharCode loop
 * that freezes the composer for the length of a video.
 */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.onload = () => {
      try {
        resolve(parseDataUrl(reader.result))
      } catch (error) {
        reject(error)
      }
    }
    reader.readAsDataURL(file)
  })
}

function parseDataUrl(result: string | ArrayBuffer | null): string {
  if (result === null || result instanceof ArrayBuffer)
    throw new Error("file reader returned no data URL")
  const separator = result.indexOf(",")
  if (separator === -1)
    throw new Error("file reader returned an invalid data URL")
  return result.slice(separator + 1)
}

/**
 * Assemble what actually gets sent. The draft keeps its `[Attachment N]`
 * markers so the model can tell which one a sentence refers to, and an
 * appendix explains what each marker is.
 */
export function buildPrompt(
  draft: string,
  items: Attachment[]
): AttachmentPrompt {
  const images: InlineAttachmentImage[] = []
  const appendix: string[] = []

  for (const item of items) {
    if (item.kind === "image" && item.data) {
      images.push({ mimeType: item.mimeType, data: item.data })
      appendix.push(
        `[Attachment ${item.index}] ${item.name} — image, attached inline above.${item.context ? `\n${item.context}` : item.contextPath ? `\nWindow text saved at ${item.contextPath}; read it alongside the image.` : ""}`
      )
      continue
    }
    if (item.kind === "text" && item.text !== undefined) {
      appendix.push(
        `[Attachment ${item.index}] ${item.name}\n\`\`\`\n${item.text}\n\`\`\``
      )
      continue
    }
    if (item.stagedPath) {
      appendix.push(
        `[Attachment ${item.index}] ${item.name} — ${item.mimeType}, ${formatBytes(item.size)}. ` +
          `Saved at ${item.stagedPath}; read it from there if you need its contents.`
      )
    }
  }

  if (appendix.length === 0) return { text: draft, images }
  const body = attachmentPromptText(draft, items).trim()
  return {
    text: `${body}${body ? "\n\n" : ""}---\n${appendix.join("\n\n")}`,
    images,
  }
}

/**
 * The prompt for a harness reached through its CLI: no inline images, so
 * every attachment — image included — resolves to its staged file, and the
 * [Attachment N] markers the draft carries point at real paths the agent
 * can open. Anything still unstaged is named honestly as unavailable
 * rather than silently dropped.
 */
export function buildForeignPrompt(draft: string, items: Attachment[]): string {
  const appendix: string[] = []
  for (const item of items) {
    if (item.stagedPath) {
      appendix.push(
        `[Attachment ${item.index}] ${item.name} — ${item.mimeType}, ${formatBytes(item.size)}. ` +
          `Saved at ${item.stagedPath}; read it from there.${item.contextPath ? ` Window text saved at ${item.contextPath}; read it alongside the image.` : ""}`
      )
    } else if (item.kind === "text" && item.text !== undefined) {
      appendix.push(`[Attachment ${item.index}] ${item.name}
\`\`\`
${item.text}
\`\`\``)
    } else {
      appendix.push(
        `[Attachment ${item.index}] ${item.name} — could not be staged; ask for it again.`
      )
    }
  }
  if (appendix.length === 0) return draft
  const body = attachmentPromptText(draft, items).trim()
  return `${body}${body ? "\n\n" : ""}---\n${appendix.join("\n\n")}`
}

/**
 * The reverse read: a prompt that went out with an attachment appendix
 * comes back from the session file as one text block. Splitting the
 * appendix off lets the transcript show the words as words and the files
 * as chips — the attachment stays visible forever, not just at send time.
 */
export function parseAttachmentAppendix(
  text: string
): ParsedAttachmentAppendix {
  const separator = text.lastIndexOf("\n---\n[Attachment ")
  const at =
    separator >= 0 ? separator : text.startsWith("---\n[Attachment ") ? 0 : -1
  if (at === -1) return { body: text, files: [] }
  const appendix = text.slice(at + (separator >= 0 ? 5 : 4))
  const files: AttachmentFileReference[] = []
  const filePattern = /\[Attachment (\d+)\] (.+?) — ([^,\n]+), [^\n]*?Saved at (.+?); read it from there(?: if you need its contents)?\.(?: Window text saved at (.+?); read it alongside the image\.)?/g
  for (const match of appendix.matchAll(filePattern)) {
    files.push({ index: Number(match[1]), name: match[2]!, mimeType: match[3]!, path: match[4]!, contextPath: match[5] })
  }
  if (files.length === 0) return { body: text, files: [] }
  const remaining = appendix.replace(filePattern, "").trim()
  return {
    body: [text.slice(0, at).trimEnd(), remaining].filter(Boolean).join("\n\n"),
    files,
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Reloaded drafts keep disk paths, not stale blob URLs or base64 in localStorage. */
export function useAttachmentPreview(item: Attachment) {
  const [resolved, setResolved] = useState<{
    path: string
    preview: { kind: "ready"; url: string } | { kind: "unavailable" }
  } | null>(null)
  useEffect(() => {
    const path = item.stagedPath
    if (!/^(image|video|audio)\//.test(item.mimeType) || item.preview || !path) return
    let current = true
    void getMako()
      .readFile(path)
      .then((file) => {
        if (current)
          setResolved({ path, preview: file.previewUrl ? { kind: "ready", url: getMako().resolveFileUrl(file.previewUrl) } : { kind: "unavailable" } })
      })
      .catch(() => {
        if (current) setResolved({ path, preview: { kind: "unavailable" } })
      })
    return () => {
      current = false
    }
  }, [item.mimeType, item.preview, item.stagedPath])
  if (item.preview) return { kind: "ready", url: item.preview } as const
  return resolved?.path === item.stagedPath ? resolved?.preview : undefined
}

function attachmentMetadata(item: Attachment): Attachment {
  return {
    ...item,
    preview: undefined,
    data: undefined,
    text: undefined,
    context: undefined,
  }
}

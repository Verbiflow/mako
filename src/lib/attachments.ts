import { classify } from "./attachment-kind"
export { classify } from "./attachment-kind"
import type { ContextDetail, ContextInput } from "./context-detail"
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
 * Each record's anchor keeps its place in the draft; the composer paints it
 * as a removable chip, and `src/lib/context/` writes it into the prompt as
 * a marker and an item pointing at its staged contents.
 */

/**
 * Where Mako made an attachment from, when Mako made it: the tile draws
 * terminal output as a terminal, a conflict snapshot as a conflict and a
 * pull request snapshot by its number and state.
 */
export type AttachmentOrigin = "terminal" | "git-conflicts" | "pull-request" | "window"

/** Whose window an Appshot is: the tile and chip show the app's icon, its name and the window's title. */
export interface CapturedWindowInfo {
  app: string
  title: string
  /** The app's icon as a `data:` URL, while the desk has one; not carried in the message. */
  icon?: string
}

export type AttachmentInput = File | { file: File; context?: string; contextLabel?: string; origin?: AttachmentOrigin; detail?: ContextDetail; window?: CapturedWindowInfo }

export type AttachmentKind = "image" | "text" | "binary"

/**
 * A context record in a draft: a file the person attached or Mako made, or
 * a `detail` (a comment on lines, a picked element, a quote, a pull
 * request), or both, as a picked element carries its crop. The draft places
 * it by its anchor; `src/lib/context/` writes it into the prompt by kind.
 */
export interface Attachment {
  id: string
  /** How a draft from before anchors placed it, `[name]`; read only to restore one. */
  reference?: string
  detail?: ContextDetail
  /** Compact, named context instead of a media/file thumbnail. */
  contextLabel?: string
  origin?: AttachmentOrigin
  /** For a window capture: whose window. */
  window?: CapturedWindowInfo
  /** 1-based, matching the `[Attachment N]` marker in the draft. */
  index: number
  name: string
  mimeType: string
  /** Native history may retain a file path without its original byte count. */
  size?: number
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
  /** That context's text while the desk holds it: a window capture's elements (`window-outline.ts`). */
  context?: string
  /** True while the file is being read or staged. */
  pending?: boolean
  error?: string
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
        const origin = input instanceof File ? undefined : input.origin
        const detail = input instanceof File ? undefined : input.detail
        const captured = input instanceof File ? undefined : input.window
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
            id: crypto.randomUUID(),
            index,
            name: file.name,
            contextLabel,
            origin,
            detail,
            ...(captured && { window: captured }),
            mimeType,
            size: file.size,
            kind,
            context,
            preview: (/^(image|video|audio)\//.test(mimeType) || mimeType === "application/pdf") ? URL.createObjectURL(file) : undefined,
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
   * Add a record something on screen made (`addContext`): a detail alone,
   * which needs no staging, or a detail with an image beside it, staged like
   * any file. Returns its anchor for the caller to place.
   */
  const addRecord = useCallback(
    (input: ContextInput): string => {
      if (input.image)
        return add([{ file: input.image, contextLabel: input.label, detail: input.detail }])
      const index = Math.max(
        nextIndex.current.get(key) ?? 1,
        ...(live.current.get(key) ?? []).map((item) => item.index + 1),
        ...(removed.current.get(key) ?? []).map((item) => item.index + 1)
      )
      nextIndex.current.set(key, index + 1)
      const record: Attachment = {
        id: crypto.randomUUID(),
        index,
        name: input.label,
        contextLabel: input.label,
        mimeType: "text/plain",
        kind: "text",
        detail: input.detail,
      }
      updateItems((current) => [...current, record])
      return attachmentReference(record)
    },
    [add, key, updateItems]
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
    addRecord,
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
 * How a prompt from before October 12 carried its files: an appendix of
 * `[Attachment N] name — type, size. Saved at …` lines after the words.
 * Only `src/lib/context/sent.ts` reads it, to draw such a prompt the way
 * it draws every other.
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

export function formatBytes(bytes: number | undefined) {
  if (bytes === undefined) return "Size unknown"
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
    if ((!/^(image|video|audio)\//.test(item.mimeType) && item.mimeType !== "application/pdf") || item.preview || !path) return
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

/** A text attachment's words after a paste or a reload, which carry only its path: read once from the staged copy. */
export function useAttachmentText(item: Attachment): string | undefined {
  const [resolved, setResolved] = useState<{ path: string; text: string | undefined } | null>(null)
  const path = item.kind === "text" && item.text === undefined && !item.pending ? item.stagedPath : undefined
  useEffect(() => {
    if (!path) return
    let current = true
    void getMako()
      .readFile(path)
      .then(
        (file) => current && setResolved({ path, text: file.binary ? undefined : file.contents.slice(0, MAX_INLINE_TEXT) }),
        () => current && setResolved({ path, text: undefined })
      )
    return () => {
      current = false
    }
  }, [path])
  if (item.text !== undefined) return item.text
  return resolved?.path === path ? resolved?.text : undefined
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

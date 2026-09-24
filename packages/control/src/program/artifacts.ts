import { createHash, randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { z } from "zod"
import type { JsonValue } from "../json.js"

/**
 * Where a control program's oversized results go instead of being cut.
 *
 * A tool result has to fit a provider's tool-result limit, but a page's
 * accessibility tree or a 4,000-element window state is not made smaller
 * by dropping its tail: an agent that reads a truncated preview reasons
 * about a page that does not exist. Anything a program returns, logs or
 * emits beyond the inline budget is written whole to one file, and the
 * result carries a receipt naming the file, its size and hash, and an
 * outline of the value's shape so the agent knows what is in it and can
 * read the part it needs with its own file tools or a follow-up program.
 */

/**
 * One text block this large or larger is written to a file instead. About
 * 10 K tokens: a whole window state or page tree is never in a model's
 * context by accident, while any selection a program meant to return fits.
 * Measured 2026-09-14: the same task cost 306 K prompt tokens with a 200 KB
 * budget and 18 K with the results bounded (docs/audits/2026-09-14).
 */
export const INLINE_TEXT_BUDGET = 40_000
/** Once a run's inline text passes this, every further text block is written to a file. */
export const INLINE_TOTAL_BUDGET = 60_000
/** Images past this count in one run are written to files and described. */
export const INLINE_IMAGE_COUNT = 4
/** Base64 bytes, below the session reply limit even with text and receipts. */
export const INLINE_IMAGE_BYTES = 24 * 1024 * 1024
const OUTLINE_KEYS = 40
const OUTLINE_SAMPLE = 3
const OUTLINE_HEAD = 240
const OUTLINE_DEPTH = 2
const NAME_LENGTH = 64

export interface ArtifactOutline {
  type: "object" | "array" | "string" | "number" | "boolean" | "null"
  bytes: number
  keys?: Array<{ name: string; type: ArtifactOutline["type"]; bytes: number }>
  moreKeys?: number
  length?: number
  sample?: ArtifactOutline[]
  head?: string
}

export interface ArtifactReceipt {
  artifact: true
  kind: "json" | "image"
  path: string
  bytes: number
  sha256: string
  mimeType?: string
  outline?: ArtifactOutline
  note: string
}

export function controlArtifactsDirectory(
  namespace: string,
  taskId?: string
): string {
  const root =
    process.env.MAKO_CONTROL_ARTIFACTS ??
    join(tmpdir(), "mako-control-artifacts", taskId ?? `pid-${process.pid}`)
  return join(root, namespace)
}

const jsonString = z.string()
const jsonArray = z.array(z.json())
const jsonObject = z.record(z.string(), z.json())

function typeOf(value: JsonValue): ArtifactOutline["type"] {
  if (value === null) return "null"
  if (jsonString.safeParse(value).success) return "string"
  if (jsonArray.safeParse(value).success) return "array"
  if (jsonObject.safeParse(value).success) return "object"
  return z.number().safeParse(value).success ? "number" : "boolean"
}

/** A structural summary an agent can decide from without reading the value. */
export function outlineOf(
  value: JsonValue,
  depth = OUTLINE_DEPTH
): ArtifactOutline {
  const bytes = Buffer.byteLength(JSON.stringify(value))
  const text = jsonString.safeParse(value)
  if (text.success) {
    return {
      type: "string",
      bytes,
      length: text.data.length,
      head:
        text.data.length > OUTLINE_HEAD
          ? text.data.slice(0, OUTLINE_HEAD)
          : text.data,
    }
  }
  const list = jsonArray.safeParse(value)
  if (list.success) {
    const outline: ArtifactOutline = {
      type: "array",
      bytes,
      length: list.data.length,
    }
    if (depth > 0)
      outline.sample = list.data
        .slice(0, OUTLINE_SAMPLE)
        .map((entry) => outlineOf(entry, depth - 1))
    return outline
  }
  const record = value === null ? undefined : jsonObject.safeParse(value)
  if (record?.success) {
    const entries = Object.entries(record.data)
    const outline: ArtifactOutline = {
      type: "object",
      bytes,
      keys: entries.slice(0, OUTLINE_KEYS).map(([name, entry]) => ({
        name,
        type: typeOf(entry),
        bytes: Buffer.byteLength(JSON.stringify(entry)),
      })),
    }
    if (entries.length > OUTLINE_KEYS)
      outline.moreKeys = entries.length - OUTLINE_KEYS
    return outline
  }
  return { type: typeOf(value), bytes }
}

/** A file name from the caller's label: one path segment, bounded, unique. */
export function artifactFileName(label: string, extension: string): string {
  const stem =
    basename(label)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+/, "")
      .slice(0, NAME_LENGTH) || "artifact"
  return `${stem}-${randomUUID().slice(0, 8)}.${extension}`
}

async function write(
  directory: string,
  name: string,
  body: Buffer
): Promise<{ path: string; sha256: string }> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, name)
  await writeFile(path, body)
  return { path, sha256: createHash("sha256").update(body).digest("hex") }
}

export async function spillJson(
  directory: string,
  label: string,
  value: JsonValue,
  text = JSON.stringify(value)
): Promise<ArtifactReceipt> {
  const body = Buffer.from(text)
  const written = await write(directory, artifactFileName(label, "json"), body)
  return {
    artifact: true,
    kind: "json",
    ...written,
    bytes: body.byteLength,
    outline: outlineOf(value),
    note: "This value was larger than the inline budget, so the complete JSON was written to the file above and nothing was cut. Read the part you need from the file, or return a narrower selection from the next program.",
  }
}

export async function spillImage(
  directory: string,
  label: string,
  data: string,
  mimeType: string
): Promise<ArtifactReceipt> {
  const body = Buffer.from(data, "base64")
  const written = await write(
    directory,
    artifactFileName(label, mimeType === "image/png" ? "png" : "jpg"),
    body
  )
  return {
    artifact: true,
    kind: "image",
    ...written,
    bytes: body.byteLength,
    mimeType,
    note: "The complete image was saved to the file above rather than inlined. Read it with your file/image tools; its pixels were not resized or discarded.",
  }
}

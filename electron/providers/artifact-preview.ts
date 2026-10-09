import { createHash } from "node:crypto"
import type { ProviderCapability } from "./registry.js"

/** Builds a read-only document for an opaque-origin iframe; never runs artifact code in the host. */
export interface ProviderArtifactPreview extends ProviderCapability {
  /** What the harness calls these files; the viewer's preview is named by it. */
  name: string
  /** The endings of the file names it writes (`.canvas.tsx`). */
  files: readonly string[]
  /** How the harness makes them, in its own words. */
  via: string
  render(source: string): Promise<string>
}

export function previewsFile(preview: ProviderArtifactPreview, path: string): boolean {
  return preview.files.some((ending) => path.endsWith(ending))
}

const CACHED_DOCUMENTS = 16
const CACHED_BYTES = 32_000_000
const documents = new Map<string, Promise<string>>()
let cachedBytes = 0
const sizes = new Map<string, number>()

/**
 * The preview's document for this exact source. Reopening or refreshing an
 * unchanged artifact reuses its build, and two reads of one source share a
 * build in flight; a failed build is not kept.
 */
export function artifactDocument(preview: ProviderArtifactPreview, source: string): Promise<string> {
  const key = `${preview.provider}\0${createHash("sha256").update(source).digest("hex")}`
  const cached = documents.get(key)
  if (cached) {
    documents.delete(key)
    documents.set(key, cached)
    return cached
  }
  const built = preview.render(source)
  documents.set(key, built)
  built.then((html) => {
    if (documents.get(key) !== built) return
    sizes.set(key, html.length)
    cachedBytes += html.length
    for (const [oldest] of documents) {
      if (documents.size <= CACHED_DOCUMENTS && cachedBytes <= CACHED_BYTES) break
      if (oldest === key) continue
      forget(oldest)
    }
  }, () => {
    if (documents.get(key) === built) forget(key)
  })
  return built
}

function forget(key: string): void {
  documents.delete(key)
  cachedBytes -= sizes.get(key) ?? 0
  sizes.delete(key)
}

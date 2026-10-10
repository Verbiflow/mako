import { createHash } from "node:crypto"

/** Builds a read-only document for an opaque-origin iframe; never runs artifact code in the host. */
export interface ProviderArtifactPreview {
  provider: string
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

/** The harnesses' artifact previews, and the documents they built, kept while they fit. */
export class ArtifactPreviews {
  private readonly previews: () => readonly ProviderArtifactPreview[]
  private readonly documents = new Map<string, Promise<string>>()
  private readonly sizes = new Map<string, number>()
  private cachedBytes = 0

  constructor(previews: () => readonly ProviderArtifactPreview[]) { this.previews = previews }

  /** The preview a harness renders this file with, if it wrote it. */
  of(path: string): ProviderArtifactPreview | undefined {
    return this.previews().find((preview) => previewsFile(preview, path))
  }

  /**
   * The preview's document for this exact source. Reopening or refreshing an
   * unchanged artifact reuses its build, and two reads of one source share a
   * build in flight; a failed build is not kept.
   */
  document(preview: ProviderArtifactPreview, source: string): Promise<string> {
    const key = `${preview.provider}\0${createHash("sha256").update(source).digest("hex")}`
    const cached = this.documents.get(key)
    if (cached) {
      this.documents.delete(key)
      this.documents.set(key, cached)
      return cached
    }
    const built = preview.render(source)
    this.documents.set(key, built)
    built.then((html) => {
      if (this.documents.get(key) !== built) return
      this.sizes.set(key, html.length)
      this.cachedBytes += html.length
      for (const [oldest] of this.documents) {
        if (this.documents.size <= CACHED_DOCUMENTS && this.cachedBytes <= CACHED_BYTES) break
        if (oldest === key) continue
        this.forget(oldest)
      }
    }, () => {
      if (this.documents.get(key) === built) this.forget(key)
    })
    return built
  }

  private forget(key: string): void {
    this.documents.delete(key)
    this.cachedBytes -= this.sizes.get(key) ?? 0
    this.sizes.delete(key)
  }
}

import { createContext, useContext, useEffect, useId } from "react"
import type { FileContents } from "@/lib/types"

/** One picture or video a gallery can show, as its owner on the page knows it. */
export interface GalleryItem {
  name: string
  /** The file's path as the answer spelled it, for its actions; absent for an inline attachment. */
  path?: string
  file?: FileContents
  error?: string
  /** Where it sits on the page; the gallery's order is the page's. */
  element(): Element | null
  /** Asks its owner to read the file, for an item the lightbox reaches before the page did. */
  request(): void
}

/**
 * Every picture and video of one exchange, in page order: prose embeds,
 * grids and the media under an answer, each registered by what draws it.
 * Opening one opens the lightbox on it with the rest a step away. React-free
 * so registrations cost no render; only the lightbox, while open, listens.
 */
export class MediaGallery {
  private readonly items = new Map<string, GalleryItem>()
  private readonly listeners = new Set<() => void>()
  private openId: string | null = null
  private revision = 0

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** What the lightbox renders from: unchanged while closed, so registrations wake nothing. */
  readonly snapshot = () => (this.openId === null ? -1 : this.revision)

  private changed(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }

  set(id: string, item: GalleryItem): void {
    this.items.set(id, item)
    if (this.openId !== null) this.changed()
  }

  delete(id: string): void {
    if (!this.items.delete(id)) return
    if (this.openId === id) this.openId = null
    if (this.openId !== null || !this.items.size) this.changed()
  }

  /** In page order; an item whose element left the page is skipped. */
  ordered(): { id: string; item: GalleryItem }[] {
    const placed = [...this.items].flatMap(([id, item]) => {
      const element = item.element()
      return element?.isConnected ? [{ id, item, element }] : []
    })
    placed.sort((a, b) => (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    return placed.map(({ id, item }) => ({ id, item }))
  }

  open(id: string | null): void {
    if (this.openId === id) return
    this.openId = id
    if (id) {
      const item = this.items.get(id)
      if (item && !item.file && !item.error) item.request()
    }
    this.changed()
  }

  get current(): string | null {
    return this.openId
  }
}

export const GalleryContext = createContext<MediaGallery | null>(null)

/** The gallery whose lightbox a picture here opens in, if any scope encloses it. */
export function useMediaGallery(): MediaGallery | null {
  return useContext(GalleryContext)
}

/**
 * Registers a picture or video with the enclosing gallery while it is
 * mounted, keeping its file and error current; returns how to open the
 * lightbox on it, or null outside any gallery.
 */
export function useGalleryItem(item: GalleryItem | null): (() => void) | null {
  const gallery = useMediaGallery()
  const id = useId()
  useEffect(() => {
    if (!gallery || !item) return
    gallery.set(id, item)
  }, [gallery, id, item])
  useEffect(() => {
    if (!gallery) return
    return () => gallery.delete(id)
  }, [gallery, id])
  return gallery && item ? () => gallery.open(id) : null
}


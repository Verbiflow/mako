import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { GalleryContext, MediaGallery, useMediaGallery } from "./media-gallery-store"
import { ExpandedFilePreview } from "./expanded-file-preview"
import { MediaActions } from "./media-actions"

/** A gallery and its lightbox over everything inside: one per exchange, or per grid that isn't in one. */
export function MediaGalleryScope({ children }: { children: ReactNode }) {
  const [gallery] = useState(() => new MediaGallery())
  return (
    <GalleryContext value={gallery}>
      {children}
      <MediaLightbox gallery={gallery} />
    </GalleryContext>
  )
}

/** Wraps `children` in a gallery unless one already encloses them. */
export function OwnMediaGallery({ children }: { children: ReactNode }) {
  return useMediaGallery() ? children : <MediaGalleryScope>{children}</MediaGalleryScope>
}

function MediaLightbox({ gallery }: { gallery: MediaGallery }) {
  useSyncExternalStore(gallery.subscribe, gallery.snapshot, gallery.snapshot)
  const openId = gallery.current
  const items = openId === null ? [] : gallery.ordered()
  const index = items.findIndex((entry) => entry.id === openId)
  const entry = items[index]
  const go = (at: number) => {
    const next = items[at]
    if (next) gallery.open(next.id)
  }
  // Neighbours are read ahead, so stepping through a grid never waits on a file it could have had.
  useEffect(() => {
    if (index < 0) return
    for (const near of [items[index - 1], items[index + 1]]) if (near && !near.item.file && !near.item.error) near.item.request()
  })
  return (
    <ExpandedFilePreview
      file={entry?.item.file}
      error={entry?.item.error}
      identity={entry?.id}
      name={entry?.item.name ?? "Media"}
      open={!!entry}
      onOpenChange={(open) => { if (!open) gallery.open(null) }}
      focusTarget={() => {
        const element = entry?.item.element()
        return element instanceof HTMLElement ? element.querySelector<HTMLElement>("button") ?? element : null
      }}
      navigation={entry ? { index, count: items.length, previous: () => go(index - 1), next: () => go(index + 1) } : undefined}
      actions={entry?.item.file ? <MediaActions file={entry.item.file} name={entry.item.name} path={entry.item.path} /> : null}
    />
  )
}

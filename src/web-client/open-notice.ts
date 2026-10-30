import { z } from "zod"

/**
 * Where the service worker leaves a tapped notice's address for a page that's already open (Cache Storage, which both
 * read): iOS brings a Home Screen app forward exactly as it was, and its `navigate()` doesn't move it, so the page is
 * told by a message and by this note, read as it comes into view, whichever reaches it first. The worker's side is in
 * the app that hosts this client; these names are the contract between the two. Not under `mako-web-`: the worker
 * clears those caches as each build of it takes over.
 */
export const NOTICE_NOTE_CACHE = "mako-notice"
export const NOTICE_NOTE_PATH = "/__mako/notice"

/** What the service worker says when a notice is tapped: the app's address to go to. */
const OpenNoticeSchema = z.object({ type: z.literal("mako:open"), url: z.string().min(1) })
/** The note it leaves, and when. */
const NoticeNoteSchema = z.object({ url: z.string().min(1), at: z.number() })

/** A note older than this was left by a tap the page already followed, or one long gone. */
const NOTE_FRESH_MS = 120_000
/** One tap arrives up to three ways (the address it opened, the message, the note): followed once. */
const SAME_TAP_MS = 10_000

/**
 * Follows a tapped notice with the app open: `go` is given the app's address it names (a path of this origin), once
 * per tap. Returns how to stop.
 */
export function followNotices(go: (path: string) => void): () => void {
  let followed = { path: location.pathname + location.search, at: Date.now() }
  const take = (url: string) => {
    let address: URL
    try {
      address = new URL(url, location.origin)
    } catch {
      return
    }
    if (address.origin !== location.origin) return
    const path = address.pathname + address.search
    if (path === followed.path && Date.now() - followed.at < SAME_TAP_MS) return
    followed = { path, at: Date.now() }
    go(path)
  }
  const readNote = async () => {
    if (!("caches" in window)) return
    try {
      const cache = await caches.open(NOTICE_NOTE_CACHE)
      const kept = await cache.match(NOTICE_NOTE_PATH)
      if (!kept) return
      await cache.delete(NOTICE_NOTE_PATH)
      const note = NoticeNoteSchema.safeParse(await kept.json()).data
      if (note && Date.now() - note.at < NOTE_FRESH_MS) take(note.url)
    } catch {
      // No storage to read (a private window): the message is the only way, and it's enough with the app awake.
    }
  }
  const heard = (event: MessageEvent) => {
    const notice = OpenNoticeSchema.safeParse(event.data).data
    if (notice) take(notice.url)
  }
  const shown = () => {
    if (document.visibilityState === "visible") void readNote()
  }
  const worker = navigator.serviceWorker
  worker?.addEventListener("message", heard)
  document.addEventListener("visibilitychange", shown)
  window.addEventListener("pageshow", shown)
  shown()
  return () => {
    worker?.removeEventListener("message", heard)
    document.removeEventListener("visibilitychange", shown)
    window.removeEventListener("pageshow", shown)
  }
}

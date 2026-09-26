import { getMako } from "@/lib/bridge"
import type { ControlActivity, ControlPreview } from "@/lib/types"
import { createHook, createStore } from "@/state/store"

interface PreviewState {
  previews: Record<string, ControlPreview | null>
  activities: Record<string, ControlActivity>
  errors: Record<string, string | null>
}
export const controlPreviewStore = createStore<PreviewState>({
  previews: {},
  activities: {},
  errors: {},
})
export const useControlPreview = createHook(controlPreviewStore)

const watches = new Map<string, { users: number; stop: () => void }>()

export function watchControlPreview(conversationId: string): () => void {
  let watch = watches.get(conversationId)
  if (watch) watch.users++
  else {
    watch = { users: 1, stop: startWatchingControlPreview(conversationId) }
    watches.set(conversationId, watch)
  }
  let released = false
  const subscription = watch
  return () => {
    if (released) return
    released = true
    subscription.users--
    if (subscription.users === 0) {
      watches.delete(conversationId)
      subscription.stop()
    }
  }
}

function startWatchingControlPreview(conversationId: string): () => void {
  const watcher = crypto.randomUUID()
  let closed = false
  let pending = false
  let refreshRequested = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const poll = async () => {
    timer = undefined
    if (closed || document.hidden) return
    if (pending) { refreshRequested = true; return }
    pending = true
    let advanced = false
    try {
      // The host holds this read until the frame after `held` while a stream is live.
      const held = controlPreviewStore.get().previews[conversationId]?.frame?.id ?? null
      const preview = await getMako().controlPreview(
        conversationId,
        true,
        watcher,
        held
      )
      advanced = (preview?.frame?.id ?? null) !== held
      if (!closed) {
        const previous = controlPreviewStore.get().previews[conversationId]
        if (
          previous?.frame?.id !== preview?.frame?.id ||
          previous?.activity.updatedAt !== preview?.activity.updatedAt ||
          previous?.window?.windowId !== preview?.window?.windowId ||
          previous?.window?.pid !== preview?.window?.pid ||
          controlPreviewStore.get().errors[conversationId]
        )
          controlPreviewStore.set((state) => ({
            previews: { ...state.previews, [conversationId]: preview },
            errors: { ...state.errors, [conversationId]: null },
          }))
      }
    } catch {
      if (!closed)
        controlPreviewStore.set((state) => ({
          errors: {
            ...state.errors,
            [conversationId]: "The control preview is unavailable.",
          },
        }))
    } finally {
      pending = false
      if (closed || document.hidden) release()
      else if (refreshRequested || advanced) { refreshRequested = false; void poll() }
      else {
        const activity = controlPreviewStore.get().previews[conversationId]?.activity
        if (!activity || activity.kind === "browser" || activity.status === "running" || Date.now() - activity.updatedAt < 5000)
          timer = setTimeout(() => void poll(), 1000)
      }
    }
  }
  const release = () => {
    void getMako()
      .controlPreview(conversationId, false, watcher)
      .catch(() => {})
  }
  const visibility = () => {
    if (timer) clearTimeout(timer)
    if (document.hidden) release()
    else void poll()
  }
  let lastActivity = controlPreviewStore.get().activities[conversationId]
  const unsubscribe = controlPreviewStore.subscribe(() => {
    const activity = controlPreviewStore.get().activities[conversationId]
    if (activity === lastActivity) return
    lastActivity = activity
    if (timer) clearTimeout(timer)
    void poll()
  })
  document.addEventListener("visibilitychange", visibility)
  void poll()
  return () => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    document.removeEventListener("visibilitychange", visibility)
    unsubscribe()
    release()
    controlPreviewStore.set((state) => ({
      previews: Object.fromEntries(
        Object.entries(state.previews).filter(([id]) => id !== conversationId)
      ),
      errors: Object.fromEntries(
        Object.entries(state.errors).filter(([id]) => id !== conversationId)
      ),
    }))
  }
}

export function receiveControlActivity(activity: ControlActivity) {
  controlPreviewStore.set((state) => {
    const entries = Object.entries(state.activities)
      .filter(([id]) => id !== activity.conversationId)
      .slice(-63)
    return {
      activities: Object.fromEntries([
        ...entries,
        [activity.conversationId, activity],
      ]),
    }
  })
}
/** Electron captures only the already-authorized native window. No AX query or input is involved. */
const nativeStreams = new Map<string, { users: number; stream: Promise<MediaStream> }>()
export async function controlPreviewStream(
  id: string
): Promise<{ stream: MediaStream; release: () => void } | null> {
  if (!getMako().nativeWindowVideo) return null
  const source = await getMako().controlPreviewSource(id)
  if (!source) return null
  const video: MediaTrackConstraints & {
    mandatory: {
      chromeMediaSource: string
      chromeMediaSourceId: string
      maxWidth: number
      maxHeight: number
      maxFrameRate: number
    }
  } = {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: source,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 60,
    },
  }
  const key = JSON.stringify([id, source])
  let entry = nativeStreams.get(key)
  if (!entry) {
    entry = { users: 0, stream: navigator.mediaDevices.getUserMedia({ audio: false, video }) }
    nativeStreams.set(key, entry)
  }
  entry.users++
  const owned = entry
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (--owned.users === 0) {
      if (nativeStreams.get(key) === owned) nativeStreams.delete(key)
      void owned.stream.then(stream => stream.getTracks().forEach(track => track.stop())).catch(() => {})
    }
  }
  try { return { stream: await owned.stream, release } }
  catch (error) { release(); throw error }
}

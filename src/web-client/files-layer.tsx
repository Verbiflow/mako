import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { activeAcp, useAcp } from "@/state/acp-state"
import { filesScreenChunk } from "./chunks"
import { EASE_OUT, EASE_SWIFT, reducedMotion } from "./motion"
import { followFilesHistory, leftFiles, useFilesOpen, type FilesOpen } from "./files-open"
import { leftReview, reviewOpenStore } from "./review-open"
import type { WebForm } from "./route"

/**
 * Files on the web: a conversation's folder, browsed and searched on the computer that runs it, where Changes goes
 * (over the Thread on a phone, beside the transcript on a laptop), and a file read there with its source highlighted.
 * The two take turns: opening one puts the other away.
 */
export function FilesLayer({ form, place }: { form: WebForm; place: string | undefined }) {
  const open = useFilesOpen((state) => state.open)
  useEffect(() => followFilesHistory(), [])
  useEffect(() => reviewOpenStore.subscribe(() => {
    if (reviewOpenStore.get().open) leftFiles()
  }), [])
  useEffect(() => {
    if (open) leftReview()
  }, [open])
  const was = useRef(place)
  useEffect(() => {
    if (was.current !== place) leftFiles()
    was.current = place
  }, [place])
  const onScreen = useAcp((state) => activeAcp(state)?.key)
  useEffect(() => {
    if (open && onScreen && onScreen !== open.conversation) leftFiles()
  }, [open, onScreen])

  const screen = filesScreenChunk.use()
  useEffect(() => {
    if (open) void filesScreenChunk.read().catch(() => undefined)
  }, [open])

  const [shown, setShown] = useState<FilesOpen | null>(open)
  if (open && shown !== open) setShown(open)
  const layer = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    const element = layer.current
    const isOpen = open !== null
    if (isOpen === wasOpen.current || !element) return
    wasOpen.current = isOpen
    const slide = form === "phone" && !reducedMotion()
    const away: Keyframe = slide ? { transform: "translate3d(100%, 0, 0)" } : { opacity: 0, transform: form === "desk" ? "translate3d(12px, 0, 0)" : "none" }
    const here: Keyframe = slide ? { transform: "none" } : { opacity: 1, transform: "none" }
    if (isOpen) {
      element.animate([away, here], { duration: slide ? 240 : 160, easing: EASE_OUT })
      return
    }
    const gone = () => setShown(null)
    void element.animate([here, away], { duration: slide ? 180 : 120, easing: EASE_SWIFT, fill: "forwards" }).finished.then(gone, gone)
  }, [open, form])
  if (!shown) return null
  return (
    <div ref={layer} className="rv-layer" data-form={form} data-closing={open ? undefined : ""}>
      {screen ? <screen.FilesScreen key={shown.conversation} open={shown} touch={form !== "desk"} /> : null}
    </div>
  )
}


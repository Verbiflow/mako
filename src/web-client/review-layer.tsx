import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { activeAcp, useAcp } from "@/state/acp"
import { openTurnReviewWith } from "@/state/review-scope"
import { EASE_OUT, EASE_SWIFT, reducedMotion } from "./motion"
import { closeReview, deskReviewCode, followReviewHistory, leftReview, openReview, touchReviewCode, useReviewOpen, type ReviewOpen } from "./review-open"
import type { WebForm } from "./route"

/**
 * Where Changes draws, mounted once by each form: over the Thread on a phone, sliding in from the right as a screen
 * does; over the Thread's pane on a tablet; beside the transcript on a laptop's desk, where it's the desktop's own
 * review (`desk-review.tsx`). The turn line's Review opens it on that turn (`reviewTurn`), the Thread's menu on every
 * turn. It's about the Session on screen: another Session's tab, another Thread or another screen takes it away.
 */
export function ReviewLayer({ form, place }: { form: WebForm; place: string | undefined }) {
  const open = useReviewOpen((state) => state.open)
  const reader = form === "desk" ? deskReviewCode : touchReviewCode
  const code = reader.useCode()
  const readReviewCode = reader.read
  useEffect(() => followReviewHistory(), [])
  useEffect(
    () =>
      openTurnReviewWith((_workspace, turn) => {
        void readReviewCode()
        openReview({ conversation: turn.conversation, scope: { kind: "turn", requestId: turn.requestId } })
      }),
    [readReviewCode]
  )
  // Somewhere else in the app (another Thread from the rail, the list): Changes was the last place's.
  const was = useRef(place)
  useEffect(() => {
    if (was.current !== place) leftReview()
    was.current = place
  }, [place])
  // Another Session of the Thread on screen: its composer isn't the one this review's comments are for.
  const onScreen = useAcp((state) => activeAcp(state)?.key)
  useEffect(() => {
    if (open && onScreen && onScreen !== open.conversation) leftReview()
  }, [open, onScreen])
  useEffect(() => {
    if (open && !code) void readReviewCode().catch(() => undefined)
  }, [open, code, readReviewCode])
  // A Thread on screen: its Changes code is read while nothing else is, so Review opens at once.
  useEffect(() => {
    if (code || !place?.startsWith("thread:")) return
    const idle = window.requestIdleCallback ?? ((then: () => void) => window.setTimeout(then, 1_200))
    idle(() => void readReviewCode().catch(() => undefined))
  }, [code, place, readReviewCode])
  const [shown, setShown] = useState<ReviewOpen | null>(open)
  const layer = useRef<HTMLDivElement>(null)
  if (open && shown !== open) setShown(open)
  // In from the right on a phone, as a screen comes; a fade on a tablet's pane and the desk's. Out on the leaving curve, faster.
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
      {!code ? <div className="rv-screen" /> : "DeskReview" in code ? <code.DeskReview key={shown.conversation} open={shown} onClose={closeReview} /> : <code.ReviewScreen key={shown.conversation} open={shown} onClose={closeReview} />}
    </div>
  )
}

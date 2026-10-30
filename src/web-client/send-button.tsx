import { useEffect, useRef, useState } from "react"
import { CheckIcon, CornerLeftUpIcon, ListEndIcon, SquareIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { LiveSteering } from "@/lib/types"
import { SendGlyph } from "./glyphs"
import { sendChoiceDetail, type SendPresentation } from "./send-action"

/** Held this long, the button offers both ways to send instead of sending. */
export const LONG_PRESS_MS = 450
/** A finger that moves this far while held is scrolling or dragging, not pressing. */
const MOVE_PX = 10

const WORDS = { queue: "Queue", steer: "Steer" } as const

/**
 * The composer's one action, changing with the situation (`sendPresentation`): a circle with the arrow to send, the
 * square to stop, ✓ to save a queued message being edited; while the agent works and the field has words, a pill that
 * says what a tap does, Queue or Steer. Held, it offers both, each with what it does in a line, the default checked.
 * While a model or access switch is on its way (`waiting`), it turns and can't be pressed, so the message goes after it.
 */
export function SendButton({
  presentation,
  ready,
  stopping,
  waiting,
  lands,
  onSend,
  onStop,
}: {
  presentation: SendPresentation
  /** Something to send, and nothing holding it back. */
  ready: boolean
  stopping: boolean
  waiting?: string | undefined
  lands: LiveSteering | null
  onSend: (how?: "queue" | "steer") => void
  onStop: () => void
}) {
  const [choosing, setChoosing] = useState(false)
  const held = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const longPressed = useRef(false)
  const { kind, alternate } = presentation
  const offersChoice = alternate !== undefined && ready && waiting === undefined
  useEffect(() => () => clearTimeout(held.current?.timer), [])

  const release = () => {
    clearTimeout(held.current?.timer)
    held.current = null
  }
  const pressed = (event: React.PointerEvent) => {
    longPressed.current = false
    if (!offersChoice || (event.pointerType === "mouse" && event.button !== 0)) return
    held.current = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        longPressed.current = true
        held.current = null
        navigator.vibrate?.(8)
        setChoosing(true)
      }, LONG_PRESS_MS),
    }
  }
  const moved = (event: React.PointerEvent) => {
    const start = held.current
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_PX) release()
  }

  if (kind === "stop")
    return (
      <button type="button" onClick={onStop} disabled={stopping} data-send-action="stop" className="web-send web-stop" aria-label={stopping ? "Stopping…" : "Stop the turn"}>
        {stopping ? <Spinner className="size-4" /> : <SquareIcon className="size-3 fill-current" />}
      </button>
    )
  const wide = kind === "queue" || kind === "steer"
  const enabled = ready && waiting === undefined
  return (
    <span className="relative flex shrink-0">
      <button
        type="button"
        disabled={!enabled}
        aria-busy={waiting !== undefined || undefined}
        aria-label={waiting ?? (wide && alternate ? `${presentation.label}. Hold for ${WORDS[alternate]}` : presentation.label)}
        aria-haspopup={offersChoice ? "menu" : undefined}
        data-send-action={kind}
        className={cn("web-send", wide && "web-send-pill")}
        onPointerDown={pressed}
        onPointerMove={moved}
        onPointerUp={release}
        onPointerCancel={release}
        onPointerLeave={release}
        onContextMenu={(event) => {
          if (!offersChoice) return
          event.preventDefault()
          release()
          longPressed.current = true
          setChoosing(true)
        }}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false
            return
          }
          onSend()
        }}
      >
        {waiting !== undefined ? (
          <Spinner className="size-4" />
        ) : kind === "update" ? (
          <CheckIcon className="size-[18px]" strokeWidth={2.4} />
        ) : kind === "queue" ? (
          <>
            <ListEndIcon aria-hidden className="size-4" strokeWidth={2.2} />
            <span>{WORDS.queue}</span>
          </>
        ) : kind === "steer" ? (
          <>
            <CornerLeftUpIcon aria-hidden className="size-4" strokeWidth={2.2} />
            <span>{WORDS.steer}</span>
          </>
        ) : (
          <SendGlyph />
        )}
      </button>
      {choosing && offersChoice && alternate ? (
        <SendChoices
          primary={kind === "steer" ? "steer" : "queue"}
          lands={lands}
          onDismiss={() => setChoosing(false)}
          onPick={(how) => {
            setChoosing(false)
            onSend(how)
          }}
        />
      ) : null}
    </span>
  )
}

/** Both ways to send while the agent works, over the button: each with the one line it does, the default checked. */
function SendChoices({ primary, lands, onPick, onDismiss }: { primary: "queue" | "steer"; lands: LiveSteering | null; onPick: (how: "queue" | "steer") => void; onDismiss: () => void }) {
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    first.current?.focus({ preventScroll: true })
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopImmediatePropagation()
      onDismiss()
    }
    addEventListener("keydown", key, true)
    return () => removeEventListener("keydown", key, true)
  }, [onDismiss])
  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden onPointerDown={onDismiss} />
      <div role="menu" aria-label="Send this message" className="web-send-choices overlay-panel">
        {(["queue", "steer"] as const).map((how) => (
          <button key={how} ref={how === primary ? first : undefined} type="button" role="menuitemradio" aria-checked={how === primary} data-send-choice={how} className="web-send-choice" onClick={() => onPick(how)}>
            {how === "queue" ? <ListEndIcon aria-hidden className="mt-0.5 size-4 shrink-0" /> : <CornerLeftUpIcon aria-hidden className="mt-0.5 size-4 shrink-0" />}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-ui font-medium">{WORDS[how]}</span>
              <span className="text-label text-muted-foreground">{sendChoiceDetail(how, lands)}</span>
            </span>
            <CheckIcon aria-hidden className={cn("mt-0.5 size-4 shrink-0", how !== primary && "invisible")} />
          </button>
        ))}
      </div>
    </>
  )
}

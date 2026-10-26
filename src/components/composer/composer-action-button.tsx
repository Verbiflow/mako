import { ArrowUpIcon, CornerDownLeftIcon, SquareIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ComposerActionKind } from "@/lib/composer-action"

interface ComposerActionButtonProps {
  action: ComposerActionKind
  ready: boolean
  stopping: boolean
  /** What steering does with the message for this provider. */
  steerTitle?: string
  onSend: () => void
  onStop: () => void
}

/**
 * The primary action.
 *
 * Circular and lit rather than a flat pill: it is the only control in the
 * window that should look pressable from across the room, and a flat fill at
 * this size reads as a disabled placeholder. An empty running composer owns
 * the stop action; typing turns that same primary position into queue.
 */
export function ComposerActionButton({
  action,
  ready,
  stopping,
  steerTitle,
  onSend,
  onStop,
}: ComposerActionButtonProps) {
  const stop = action === "stop"
  const queue = action === "queue"
  const steer = action === "steer"
  const enabled = stop || ready
  const label = stop
    ? stopping
      ? "Stopping…"
      : "Stop"
    : queue
      ? "Queue message"
      : steer
        ? "Steer the running turn"
        : "Send"
  const title = steer && steerTitle ? steerTitle : label
  return (
    <button
      type="button"
      onClick={stop ? onStop : onSend}
      disabled={!enabled || (stop && stopping)}
      aria-label={label}
      title={title}
      className={cn(
        "composer-send pressable relative flex size-8 shrink-0 items-center justify-center rounded-none focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-ring",
        "[transition:transform_var(--duration-press)_var(--ease-out),background-color_160ms_ease,opacity_160ms_ease]",
        enabled
          ? "bg-foreground text-background hover:opacity-90"
          : "bg-foreground/10 text-faint"
      )}
    >
      {stop ? (
        <SquareIcon className="size-3 fill-current" strokeWidth={0} />
      ) : queue ? (
        <CornerDownLeftIcon className="size-4" />
      ) : (
        <ArrowUpIcon className="size-4" strokeWidth={2.2} />
      )}
    </button>
  )
}

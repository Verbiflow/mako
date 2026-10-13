import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { TextQuoteIcon } from "lucide-react"
import { commands, formatChord, keysFor } from "@/extend/commands"
import { usePrefs } from "@/state/prefs"
import type { QuoteSource } from "@/state/quote-reply"
import { cn } from "@/lib/utils"
import { useTranscriptSource } from "./source-context"
import {
  EDGE,
  QUOTE_COMMAND_ID,
  QUOTE_KEYS,
  placementIn,
  quoteSelection,
  registerPane,
  subscribe,
  type Spot,
} from "./quote-reply-selection"

/**
 * Quote part of an earlier reply into the composer as a context chip: the
 * floating Quote in reply button over one transcript, mounted through the
 * `transcript.overlay` slot inside the transcript's pane. It sits at the
 * selection's top edge or, without room there, its bottom edge. The same
 * action is the `transcript.quote-selection` command, so the chord and the
 * palette reach it too (`quote-reply-selection.ts`).
 */
export function QuoteReplyOverlay() {
  const marker = useRef<HTMLSpanElement>(null)
  const toolbar = useRef<HTMLButtonElement>(null)
  const source = useTranscriptSource()
  const sourceRef = useRef<QuoteSource>(source)
  const [spot, setSpot] = useState<Spot | null>(null)
  const keybindings = usePrefs((prefs) => prefs.keybindings)
  const command = commands.get(QUOTE_COMMAND_ID)
  const chord = formatChord(command ? keysFor(command, keybindings) : QUOTE_KEYS).join("")

  useEffect(() => {
    sourceRef.current = { liveId: source.liveId, threadPath: source.threadPath }
  }, [source.liveId, source.threadPath])

  useEffect(() => {
    const pane = marker.current?.parentElement
    if (!pane) return
    const unregister = registerPane(pane, () => sourceRef.current)
    const place = () => {
      const next = placementIn(pane)
      setSpot((previous) =>
        previous?.x === next?.x && previous?.y === next?.y && previous?.side === next?.side ? previous : next
      )
    }
    const unsubscribe = subscribe(place)
    place()
    return () => {
      unsubscribe()
      unregister()
    }
  }, [])

  // Centre on the selection, kept inside the pane: the width is the button's own.
  useLayoutEffect(() => {
    const node = toolbar.current
    const pane = marker.current?.parentElement
    if (!node || !pane || !spot) return
    const width = node.offsetWidth
    const left = Math.min(Math.max(spot.x - width / 2, EDGE), pane.clientWidth - width - EDGE)
    node.style.left = `${Math.max(left, EDGE)}px`
  }, [spot])

  return (
    <>
      <span ref={marker} hidden />
      {spot ? (
        <button
          ref={toolbar}
          type="button"
          data-quote-toolbar={spot.side}
          aria-label="Quote in reply"
          title={`Quote the selected words in your reply (${chord})`}
          // The selection is what this quotes: pressing must not clear it or move focus.
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            quoteSelection()
            setSpot(null)
          }}
          style={{ top: spot.y, left: spot.x }}
          className={cn(
            "overlay-panel pressable animate-enter group/quote absolute z-20 flex h-7 items-center gap-1.5 px-2.5",
            "text-ui text-foreground select-none whitespace-nowrap"
          )}
        >
          <TextQuoteIcon aria-hidden className="size-3.5 text-muted-foreground transition-colors duration-100 group-hover/quote:text-foreground" />
          <span>Quote in reply</span>
          <span aria-hidden className="text-label text-faint">{chord}</span>
        </button>
      ) : null}
    </>
  )
}

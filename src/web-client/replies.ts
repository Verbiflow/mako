import { useEffect, useRef, useState, type RefObject } from "react"
import { toast } from "sonner"
import type { CompactReply } from "@/components/transcript/compact-presentation"
import { createHook, createStore } from "@/state/store"

/** Held this long on a reply, it offers Copy and Branch. */
const HOLD_MS = 500
const MOVE_PX = 10

/** What each reply on screen offers, by its exchange: read by a long press on it, beside its words. */
const offered = new Map<string, CompactReply>()

/** Offers a reply's Copy and Branch to a long press on it, until it's let go (the returned function). */
export function offerReply(reply: CompactReply): () => void {
  offered.set(reply.exchange, reply)
  return () => {
    if (offered.get(reply.exchange) === reply) offered.delete(reply.exchange)
  }
}

export async function copyReply(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch (error) {
    toast.error("Not copied", { description: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

/** The branch made last, opened as its Thread's tab once its owner lists it (`useBranchOpening`). */
const branchStore = createStore<{ opening: string | undefined }>({ opening: undefined })
const useBranch = createHook(branchStore)

/** A branch opens as a new Session tab in this Thread once its host lists it. */
export async function branchReply(branch: NonNullable<CompactReply["branch"]>): Promise<void> {
  const made = await branch()
  if (made) branchStore.set({ opening: made })
}

/** Opens the branch just made as soon as the Thread lists its Session: `sessions` are the Thread's, by conversation. */
export function useBranchOpening(sessions: ReadonlyArray<{ conversation: string; session: string }>, open: (session: string) => void): boolean {
  const opening = useBranch((state) => state.opening)
  const listed = opening ? sessions.find((each) => each.conversation === opening) : undefined
  useEffect(() => {
    if (!listed) return
    branchStore.set({ opening: undefined })
    open(listed.session)
  }, [listed, open])
  return opening !== undefined
}

export interface ReplyHold {
  /** The reply held, whose choices are open. */
  reply: CompactReply | undefined
  close: () => void
}

/**
 * Whether a point is on a line of a reply's words rather than in the room around them (a margin, the space between
 * paragraphs, after a short line's end). A press on words is the platform's: it selects them, to copy one command.
 */
export function onWords(x: number, y: number): boolean {
  const node = caretNode(x, y)
  if (!(node instanceof Text) || !node.data.trim()) return false
  const range = document.createRange()
  range.selectNodeContents(node)
  return Array.from(range.getClientRects()).some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
}

/** The text node nearest a point, by the standard's caret lookup or WebKit's older one. */
function caretNode(x: number, y: number): Node | undefined {
  if ("caretPositionFromPoint" in document) return document.caretPositionFromPoint(x, y)?.offsetNode
  // SAFETY: only WebKit before the standard's lookup keeps this one, and it's asked only where it may be missing.
  const legacy = document as { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  return legacy.caretRangeFromPoint?.(x, y)?.startContainer
}

/** Drops the click a lifting finger is about to make, and only that one: the next press lets it go. */
function swallowTap(): void {
  const done = () => {
    removeEventListener("click", swallow, true)
    removeEventListener("pointerdown", done, true)
  }
  const swallow = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    done()
  }
  addEventListener("click", swallow, true)
  addEventListener("pointerdown", done, true)
}

/**
 * A long press on a reply, in `container`, outside its words: the reply's Copy and Branch in a sheet. Words stay the
 * platform's to select and copy, and a link keeps its own callout; while a press here is held, the platform starts no
 * selection or menu of its own under it. A press that moves (a scroll, which a phone also cancels) lets go, and none
 * starts while words are selected, so their handles can be dragged.
 */
export function useReplyHold(container: RefObject<HTMLElement | null>): ReplyHold {
  const [reply, setReply] = useState<CompactReply | undefined>(undefined)
  const pressed = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; held: boolean } | null>(null)
  useEffect(() => {
    const root = container.current
    if (!root) return
    const release = () => {
      clearTimeout(pressed.current?.timer)
      // The finger lifting off a hold that opened the sheet isn't a tap on what opened under it.
      if (pressed.current?.held) swallowTap()
      pressed.current = null
    }
    const down = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return
      const target = event.target instanceof Element ? event.target : null
      const words = target?.closest("[data-answer]")
      const exchange = words?.closest<HTMLElement>("[data-exchange]")?.dataset["exchange"]
      if (!exchange || target?.closest("a, button")) return
      const selection = getSelection()
      if ((selection && !selection.isCollapsed) || onWords(event.clientX, event.clientY)) return
      release()
      const press = {
        x: event.clientX,
        y: event.clientY,
        held: false,
        // Fired, it stays pressed until the finger lifts: the platform's own long press waits on it till then.
        timer: setTimeout(() => {
          const found = offered.get(exchange)
          if (!found || (!found.text && !found.branch)) return
          press.held = true
          navigator.vibrate?.(8)
          setReply(found)
        }, HOLD_MS),
      }
      pressed.current = press
    }
    const move = (event: PointerEvent) => {
      const start = pressed.current
      if (start && !start.held && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_PX) release()
    }
    // The platform's own long press (a selection starting, Android's menu) waits on ours while it's held.
    const theirs = (event: Event) => {
      if (pressed.current) event.preventDefault()
    }
    root.addEventListener("pointerdown", down)
    root.addEventListener("pointermove", move)
    root.addEventListener("pointerup", release)
    root.addEventListener("pointercancel", release)
    root.addEventListener("selectstart", theirs)
    root.addEventListener("contextmenu", theirs)
    return () => {
      release()
      root.removeEventListener("pointerdown", down)
      root.removeEventListener("pointermove", move)
      root.removeEventListener("pointerup", release)
      root.removeEventListener("pointercancel", release)
      root.removeEventListener("selectstart", theirs)
      root.removeEventListener("contextmenu", theirs)
    }
  }, [container])
  return { reply, close: () => setReply(undefined) }
}

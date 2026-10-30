import { useEffect, useRef, useState, type RefObject } from "react"
import { toast } from "sonner"
import type { CompactReply } from "@/components/transcript/compact-presentation"
import { createHook, createStore } from "@/state/store"

/** Held this long on a reply, it offers Copy and Branch. */
const HOLD_MS = 500
const MOVE_PX = 10

/** What each reply on screen offers, by its exchange: read by a long press anywhere on its words. */
const offered = new Map<string, CompactReply>()

/** Offers a reply's Copy and Branch to a long press on its words, until it's let go (the returned function). */
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
 * A long press on any reply's words, in `container`: the reply's Copy and Branch in a sheet. A press that moves (a
 * scroll, which a phone also cancels) lets go; the platform's own callout and selection don't start under it (the
 * `web-live` CSS).
 */
export function useReplyHold(container: RefObject<HTMLElement | null>): ReplyHold {
  const [reply, setReply] = useState<CompactReply | undefined>(undefined)
  const pressed = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  useEffect(() => {
    const root = container.current
    if (!root) return
    const release = () => {
      clearTimeout(pressed.current?.timer)
      pressed.current = null
    }
    const down = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return
      const target = event.target instanceof Element ? event.target : null
      const words = target?.closest("[data-answer]")
      const exchange = words?.closest<HTMLElement>("[data-exchange]")?.dataset["exchange"]
      if (!exchange || target?.closest("a, button")) return
      release()
      pressed.current = {
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          pressed.current = null
          const found = offered.get(exchange)
          if (!found || (!found.text && !found.branch)) return
          navigator.vibrate?.(8)
          setReply(found)
        }, HOLD_MS),
      }
    }
    const move = (event: PointerEvent) => {
      const start = pressed.current
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_PX) release()
    }
    root.addEventListener("pointerdown", down)
    root.addEventListener("pointermove", move)
    root.addEventListener("pointerup", release)
    root.addEventListener("pointercancel", release)
    return () => {
      release()
      root.removeEventListener("pointerdown", down)
      root.removeEventListener("pointermove", move)
      root.removeEventListener("pointerup", release)
      root.removeEventListener("pointercancel", release)
    }
  }, [container])
  return { reply, close: () => setReply(undefined) }
}

